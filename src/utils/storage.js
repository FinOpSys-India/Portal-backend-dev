'use strict';

const fs = require('fs/promises');
const path = require('path');

const config = require('../config');
const ApiError = require('./ApiError');
const logger = require('./logger');

/**
 * The one place in the API that turns bytes into stored objects and back.
 *
 * Everything above this file — the upload middlewares, userService,
 * projectDocumentService — deals only in KEYS ("avatars/18/9f3c.jpg",
 * "projects/5/1a2b.pdf"). Whether that key resolves to a folder on this machine
 * or to an object in a Supabase bucket is decided here and nowhere else, which
 * is what makes the move off local disk a change to two service files rather
 * than a change to every code path that touches a file.
 *
 * WHY THIS EXISTS AT ALL. Local disk works perfectly on a laptop and not at all
 * on a serverless host: Vercel's filesystem is read-only apart from /tmp, and
 * /tmp does not survive between invocations. So an upload and the download that
 * follows it run against two different, empty disks. The database row survives
 * (it is in Postgres) and the file does not — which is why the deployed API
 * listed documents happily and 404'd on every download.
 *
 * BUCKETS ARE NOT CREATED HERE. A bucket's visibility is the security boundary
 * for the documents one (see config.storage), and creating it implicitly from
 * application code would mean a typo in a bucket name silently produces a NEW
 * bucket with default settings rather than an error. They are created once, by
 * hand, in the Supabase dashboard.
 */

/* -------------------------------------------------------------------------- */
/* the supabase client                                                        */
/* -------------------------------------------------------------------------- */

/*
 * Built once, on first use, and only when the supabase driver is actually
 * selected. Lazy rather than created at require-time for two reasons: the test
 * suite runs on the local driver and must not need the SDK to have anything to
 * connect to, and requiring this module for `keyFor` alone (as the upload
 * middlewares do) should not open a client.
 */
let client = null;

function supabase() {
  if (!client) {
    // eslint-disable-next-line global-require
    const { createClient } = require('@supabase/supabase-js');
    client = createClient(config.storage.url, config.storage.serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

function isRemote() {
  return config.storage.driver === 'supabase';
}

/* -------------------------------------------------------------------------- */
/* keys                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Build a storage key from path segments, always with forward slashes.
 *
 * Forward slashes are not cosmetic. On Windows a key assembled with `path.join`
 * comes out as `avatars\18\9f3c.jpg`, and a backslash is not a separator in an
 * object store or in a URL — it would be carried into the row and then into a
 * link that resolves to nothing. One shape, fixed at the single point where
 * segments become a key.
 */
function keyFor(...segments) {
  return segments.map((s) => String(s).replace(/^\/+|\/+$/g, '')).join('/');
}

/**
 * Where the local driver keeps a bucket.
 *
 * The avatars bucket maps onto the folder express.static already serves, so a
 * developer's existing files and URLs keep working untouched; documents map onto
 * the separate private root they have always used. A bucket name this does not
 * recognise is a programming error, not a runtime condition — hence the throw.
 */
function localRoot(bucket) {
  if (bucket === config.storage.avatarBucket) return config.uploads.dir;
  if (bucket === config.storage.documentsBucket) return config.uploads.documentsDir;
  throw new Error(`No local root configured for bucket "${bucket}".`);
}

/**
 * A key resolved to a path on disk, refusing anything that escapes its root.
 *
 * The keys this API generates cannot contain `..` — they are built from an
 * integer id and 32 random hex characters. The check is here because this is the
 * one function that turns database text into a filesystem path, and if that
 * column is ever populated by a migration, a script, or a future code path that
 * is less careful, this is what stops it becoming an arbitrary file read.
 */
function localPath(bucket, key) {
  const root = path.resolve(localRoot(bucket));
  const resolved = path.resolve(root, key);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new ApiError(500, 'The stored file could not be located.', { code: 'STORAGE_INVALID_KEY' });
  }
  return resolved;
}

/* -------------------------------------------------------------------------- */
/* the operations                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Write an object. Overwrites anything already at the same key.
 *
 * `upsert` is on because the keys are random and a collision is therefore
 * essentially impossible — but if one ever did occur, failing the user's upload
 * over it would be the wrong answer to a problem they cannot act on.
 *
 * `contentType` is passed through so the object store records the same type the
 * database row records. Without it Supabase stores everything as
 * application/octet-stream, and the download would lose the type the upload
 * measured.
 */
async function putObject({ bucket, key, body, contentType }) {
  if (isRemote()) {
    const { error } = await supabase()
      .storage.from(bucket)
      .upload(key, body, { contentType, upsert: true });

    if (error) {
      throw new ApiError(502, 'The file could not be stored.', {
        code: 'STORAGE_WRITE_FAILED',
        details: { reason: error.message },
      });
    }
    return { bucket, key };
  }

  const absolute = localPath(bucket, key);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, body);
  return { bucket, key };
}

/**
 * Read an object back as a Buffer.
 *
 * A Buffer rather than a stream, deliberately. The per-file cap is 25 MB, so the
 * object fits in memory comfortably, and buffering means the SIZE IS KNOWN
 * BEFORE THE RESPONSE STARTS — the download can set Content-Length and, more
 * importantly, can still turn a missing object into a clean 404. A stream that
 * fails midway leaves the headers already sent and the client holding a
 * truncated file that looks like a success.
 *
 * Returns null when the object is not there rather than throwing, because every
 * caller has a better answer for that case than a generic error: a document
 * whose bytes are missing is a 404 on the document.
 */
async function getObject({ bucket, key }) {
  if (isRemote()) {
    const { data, error } = await supabase().storage.from(bucket).download(key);
    if (error || !data) return null;
    return Buffer.from(await data.arrayBuffer());
  }

  try {
    return await fs.readFile(localPath(bucket, key));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Remove objects, best effort — NEVER THROWS.
 *
 * Every caller is on a path where the database has already decided the outcome:
 * a row was replaced, or a transaction failed and the bytes it referred to are
 * now garbage. Turning a failed cleanup into a thrown error would replace the
 * real result with an unrelated one — telling a user their upload failed because
 * a DIFFERENT file could not be deleted. An orphaned object costs a few
 * kilobytes; a wrong error costs them the work.
 */
async function removeObjects({ bucket, keys, requestId }) {
  const list = (Array.isArray(keys) ? keys : [keys]).filter(Boolean);
  if (!list.length) return;

  try {
    if (isRemote()) {
      const { error } = await supabase().storage.from(bucket).remove(list);
      if (error) throw new Error(error.message);
      return;
    }

    await Promise.all(
      list.map(async (key) => {
        try {
          await fs.unlink(localPath(bucket, key));
        } catch (err) {
          // The normal case for a file already gone — a retried delete, a
          // manually cleaned folder. Not worth a line in the log.
          if (err.code !== 'ENOENT') throw err;
        }
      })
    );
  } catch (err) {
    logger.warn(`[${requestId ?? '-'}] Could not remove ${list.length} object(s) from ${bucket}: ${err.message}`);
  }
}

/**
 * A short-lived URL for a PRIVATE object, or null if there isn't one to give.
 *
 * WHY THIS EXISTS. The download route used to read the object into a Buffer and
 * send it back through this API. Correct, and impossible on a serverless host
 * past a few megabytes: the platform buffers the whole response before it leaves
 * and refuses anything over roughly 4.5 MB (see config.PLATFORM_BODY_LIMIT), so
 * a 10 MB scan failed with the host's error page rather than ours. Handing back
 * a signed URL takes this API out of the data path entirely — the browser fetches
 * from the bucket, and the size of the file stops being our problem.
 *
 * THE ACCESS CHECK IS NOT WEAKENED BY THIS, which is the thing to be sure of.
 * The caller still has to authenticate, still has to be party to the project's
 * company, and only after that decision is made does a link get minted. What
 * changes is where the bytes travel, not who is allowed to ask. The link is
 * unguessable, expires in `signedUrlTtlSeconds`, and grants exactly one object.
 *
 * `download` sets the object's Content-Disposition to `attachment` with that
 * filename, which is what preserves the two properties the buffered route got
 * from its own headers: the browser saves the file instead of rendering it (so a
 * user-supplied HTML file cannot execute against anything), and the person gets
 * back the name they uploaded rather than the random storage key.
 *
 * Returns null under the local driver — there is nothing to sign, and the caller
 * falls back to reading the bytes, which on a laptop is exactly right. Also null
 * when the object is missing, since Supabase declines to sign a key that is not
 * there; the caller treats that as the 404 it is.
 */
async function signedUrl({ bucket, key, expiresIn, download }) {
  if (!isRemote() || !key) return null;

  const { data, error } = await supabase()
    .storage.from(bucket)
    .createSignedUrl(key, expiresIn || config.storage.signedUrlTtlSeconds);

  if (error || !data?.signedUrl) return null;

  /*
   * `download` IS APPENDED BY HAND rather than passed as the SDK's option, and
   * that is not a preference — the option encodes the value twice. A file called
   * "Jira (2).csv" came back as `download=Jira+%25282%2529.csv`, and since `%25`
   * is an encoded `%`, the browser saved it as "Jira %282%29.csv". Every name
   * containing a space, a bracket or an accent — which is most names a person
   * types — arrived mangled.
   *
   * Encoding it once here produces `download=Jira%20(2).csv`, and Supabase
   * answers with `Content-Disposition: attachment; filename=Jira%20(2).csv`,
   * which is the name the user uploaded.
   *
   * An empty value is still meaningful: it asks for the attachment disposition
   * using the object's own stored name. That is the fallback when no name is
   * given, and it is why the parameter is appended either way — without it the
   * browser would render the file in the tab instead of saving it, and a
   * user-supplied HTML file rendering on any origin is exactly what the
   * attachment header exists to prevent.
   */
  return `${data.signedUrl}&download=${download ? encodeURIComponent(download) : ''}`;
}

/**
 * A one-shot URL the browser may PUT a file to, or null if there isn't one.
 *
 * The other half of the same idea as `signedUrl`, and it exists for the same
 * reason: a serverless host buffers the whole request body before the function
 * sees it and refuses anything past ~4.5 MB, so a file that travels THROUGH this
 * API can never be larger than that no matter what the config allows. Handing the
 * browser a link to push the bytes to instead takes the API out of the path, and
 * the size becomes Supabase's business rather than the platform's.
 *
 * THE KEY IS ALWAYS GENERATED BY US and baked into the signature, which is what
 * keeps this from being an open write. The caller cannot choose where the object
 * lands — not the bucket, not the prefix, not the filename — so a signed ticket
 * grants exactly one write, to one path, that this API has already decided the
 * user is allowed to make. It is `upsert: false` for the same reason: a ticket
 * must not be usable to overwrite an object that already exists there.
 *
 * WHAT IT DOES NOT DO is decide what ends up recorded. The bytes landing in the
 * bucket is not the same event as a document existing, and nothing here trusts
 * the client's account of what it uploaded — see `statObject`, which is how the
 * confirm step learns the file's REAL size and type from the bucket itself.
 *
 * Null under the local driver: there is no signing authority on a filesystem, and
 * the caller turns that into a clear error rather than pretending.
 */
async function signedUploadUrl({ bucket, key }) {
  if (!isRemote() || !key) return null;

  const { data, error } = await supabase().storage.from(bucket).createSignedUploadUrl(key);

  if (error || !data?.signedUrl) return null;
  return { url: data.signedUrl, token: data.token, key };
}

/**
 * What the store itself says about an object — `{ sizeBytes, contentType }` — or
 * null if it is not there.
 *
 * THE POINT OF THIS FUNCTION IS DISTRUST. The browser uploads straight to the
 * bucket, so nobody on this side sees a byte, and the confirm call that follows
 * carries only the client's claims about what it sent. A claim is not a
 * measurement: an unchecked one would let a 200 MB file register itself as 1 KB,
 * or a .exe register itself as a PDF, and the type allowlist and the size cap
 * would both become decorative.
 *
 * So the confirm step asks the bucket. What comes back is what is really stored,
 * and that is what the row records.
 *
 * Implemented with `list` rather than a metadata call because listing one
 * prefix with an exact search is the operation every version of the client
 * agrees on, and this must not break on an SDK upgrade.
 */
async function statObject({ bucket, key }) {
  if (!key) return null;

  if (isRemote()) {
    const slash = key.lastIndexOf('/');
    const prefix = slash === -1 ? '' : key.slice(0, slash);
    const name = slash === -1 ? key : key.slice(slash + 1);

    const { data, error } = await supabase()
      .storage.from(bucket)
      .list(prefix, { search: name, limit: 100 });

    if (error || !Array.isArray(data)) return null;

    // `search` is a prefix match, not an equality one, so the exact name still
    // has to be picked out of what comes back.
    const found = data.find((o) => o.name === name);
    if (!found) return null;

    return {
      sizeBytes: Number(found.metadata?.size ?? 0),
      contentType: found.metadata?.mimetype || null,
    };
  }

  try {
    const stat = await fs.stat(localPath(bucket, key));
    // A filesystem records no content type. Null rather than a guess: the caller
    // has the extension and the allowlist, and inventing a type here would be the
    // very trust this function exists to avoid.
    return { sizeBytes: stat.size, contentType: null };
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * A URL a browser can fetch directly — PUBLIC BUCKETS ONLY.
 *
 * Built by string rather than by asking the SDK, so it stays synchronous and
 * opens no client: the DTO that needs it renders for every user in every list
 * response, and an async call there would spread through half the serialisation
 * layer for a value that is a deterministic function of the key.
 *
 * This must never be used for the documents bucket. That bucket is private, so
 * the URL would fail — which is the correct outcome, but the real point is that
 * documents are meant to leave through the authorized download route, and a
 * helper that hands out direct links to them is the first step toward one
 * ending up in a response.
 */
function publicUrl({ bucket, key }) {
  if (!key) return null;
  if (isRemote()) {
    return `${config.storage.url}/storage/v1/object/public/${bucket}/${key}`;
  }
  return `${config.uploads.publicBaseUrl}${config.uploads.publicPath}/${key}`;
}

module.exports = {
  isRemote,
  keyFor,
  putObject,
  getObject,
  statObject,
  removeObjects,
  signedUrl,
  signedUploadUrl,
  publicUrl,
};
