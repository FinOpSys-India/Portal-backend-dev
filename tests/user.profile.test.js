'use strict';

/**
 * Integration tests for the caller's own account: GET/PATCH /users/me and the
 * avatar upload/removal — through the real Express app with Prisma mocked.
 *
 * The upload path is the reason this file sets UPLOAD_DIR before requiring the
 * app: multer writes real bytes to a real directory, and a test that scattered
 * files into the project's own uploads folder would leave the working tree dirty
 * and let one run's leftovers change the next run's result.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'portal-upload-test-'));
process.env.UPLOAD_DIR = UPLOAD_DIR;
process.env.UPLOAD_PUBLIC_BASE_URL = 'http://test.local';

const mockPrisma = {
  user: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), update: jest.fn() },
  address: { create: jest.fn(), update: jest.fn() },
  companyAddress: { count: jest.fn() },
  $transaction: jest.fn(async (cb) => cb(mockPrisma)),
};

jest.mock('../src/config/prisma', () => ({
  prisma: mockPrisma,
  connectDatabase: jest.fn(),
  disconnectDatabase: jest.fn(),
}));

const request = require('supertest');
const app = require('../src/app');
const { signAccessToken } = require('../src/utils/tokens');

const USER_ID = 11;

/* A real 1x1 PNG — multer sniffs nothing, but a genuine file keeps the fixture
 * honest and lets the served bytes be compared if this ever grows a static test. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function auth(userId = USER_ID) {
  return `Bearer ${signAccessToken({ userId, email: 'am@finopsys.ai', role: 'ACCOUNTING_MANAGER', specificRole: null })}`;
}

function address(overrides = {}) {
  return {
    id: 15,
    line1: '1 Market St',
    line2: null,
    city: 'San Francisco',
    state: 'CA',
    postalCode: '94105',
    country: 'United States',
    countryCode: 'US',
    ...overrides,
  };
}

function profile(overrides = {}) {
  return {
    id: USER_ID,
    firstName: 'AM',
    lastName: 'User',
    email: 'am@finopsys.ai',
    phone: null,
    jobTitle: null,
    status: 'ACTIVE',
    avatarKey: null,
    addressId: null,
    createdAt: new Date('2026-08-01T00:00:00Z'),
    updatedAt: new Date('2026-08-01T00:00:00Z'),
    role: { code: 'ACCOUNTING_MANAGER' },
    specificRole: null,
    address: null,
    ...overrides,
  };
}

/** A valid address body as the client sends it (camelCase, un-normalised). */
function addressBody(overrides = {}) {
  return {
    addressLine1: '1 Market St',
    city: 'San Francisco',
    state: 'California',
    postalCode: '94105',
    country: 'United States',
    countryCode: 'us',
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  // Start every test with an empty upload directory. Files written by one test
  // would otherwise be counted by the next, and "no file was left behind" is an
  // assertion several of these make.
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  mockPrisma.$transaction.mockImplementation(async (cb) => cb(mockPrisma));
  mockPrisma.user.findUnique.mockResolvedValue(profile());
  mockPrisma.user.update.mockResolvedValue(profile());
  mockPrisma.user.count.mockResolvedValue(0);
  mockPrisma.companyAddress.count.mockResolvedValue(0);
});

afterAll(() => {
  fs.rmSync(UPLOAD_DIR, { recursive: true, force: true });
});

/** Every file currently under the upload directory, as relative paths. */
function uploadedFiles(dir = UPLOAD_DIR) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? uploadedFiles(full) : [full];
  });
}

/* -------------------------------------------------------------------------- */
/* GET /users/me                                                              */
/* -------------------------------------------------------------------------- */

describe('GET /users/me', () => {
  it('returns the caller with their address and avatar URL', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(
      profile({ phone: '+1 415 555 0123', avatarKey: 'avatars/11/abc.png', address: address() })
    );

    const res = await request(app).get('/api/users/me').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({
      id: USER_ID,
      email: 'am@finopsys.ai',
      phone: '+1 415 555 0123',
      role: 'ACCOUNTING_MANAGER',
      avatarUrl: 'http://test.local/uploads/avatars/11/abc.png',
      address: { addressLine1: '1 Market St', city: 'San Francisco', countryCode: 'US' },
    });
  });

  it('reports no picture and no address as null rather than omitting them', async () => {
    const res = await request(app).get('/api/users/me').set('Authorization', auth());

    expect(res.status).toBe(200);
    // A client renders a placeholder from these; an absent key and a null one are
    // not the same thing to `??`.
    expect(res.body.data.avatarUrl).toBeNull();
    expect(res.body.data.address).toBeNull();
  });

  it('never returns the password hash or login-security columns', async () => {
    const res = await request(app).get('/api/users/me').set('Authorization', auth());

    const body = JSON.stringify(res.body);
    expect(body).not.toContain('passwordHash');
    expect(body).not.toContain('failedLoginAttempts');
    expect(body).not.toContain('lastLoginIpHash');
    // The storage key stays internal — the client gets a URL or nothing.
    expect(body).not.toContain('avatarKey');
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/users/me');

    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('AUTH_REQUIRED');
  });

  it('401s when the token subject no longer exists', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);

    const res = await request(app).get('/api/users/me').set('Authorization', auth());

    expect(res.status).toBe(401);
  });
});

/* -------------------------------------------------------------------------- */
/* PATCH /users/me                                                            */
/* -------------------------------------------------------------------------- */

describe('PATCH /users/me', () => {
  it('updates the phone number alone without touching the address', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth())
      .send({ phone: '+1 415 555 0123' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { phone: '+1 415 555 0123' } })
    );
    expect(mockPrisma.address.create).not.toHaveBeenCalled();
    expect(mockPrisma.address.update).not.toHaveBeenCalled();
  });

  it('creates an address row and links it when the user has none', async () => {
    mockPrisma.address.create.mockResolvedValue(address());

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth())
      .send({ address: addressBody() });

    expect(res.status).toBe(200);
    expect(mockPrisma.address.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ line1: '1 Market St', city: 'San Francisco' }),
    });
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { addressId: 15 } })
    );
  });

  it('normalises the state and country code before storing them', async () => {
    mockPrisma.address.create.mockResolvedValue(address());

    await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth())
      .send({ address: addressBody({ state: 'California', countryCode: 'us' }) });

    // "California" and "us" are what a person types; "CA" and "US" are what an
    // invoice needs. Rejecting the first to obtain the second would just move the
    // work to the user.
    expect(mockPrisma.address.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ state: 'CA', countryCode: 'US' }),
    });
  });

  it('updates the existing address row in place when nothing else references it', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(profile({ addressId: 15, address: address() }));

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth())
      .send({ address: addressBody({ addressLine1: '2 Market St' }) });

    expect(res.status).toBe(200);
    expect(mockPrisma.address.update).toHaveBeenCalledWith({
      where: { id: 15 },
      data: expect.objectContaining({ line1: '2 Market St' }),
    });
    expect(mockPrisma.address.create).not.toHaveBeenCalled();
  });

  it('branches off a private copy rather than rewriting a SHARED address row', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(profile({ addressId: 15, address: address() }));
    // Another user points at the same row — `addresses` is a shared table.
    mockPrisma.user.count.mockResolvedValue(1);
    mockPrisma.address.create.mockResolvedValue(address({ id: 16 }));

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth())
      .send({ address: addressBody({ addressLine1: '2 Market St' }) });

    expect(res.status).toBe(200);
    // Editing in place would have silently rewritten an address its owner never
    // touched. The caller gets a new row; everyone else keeps theirs.
    expect(mockPrisma.address.update).not.toHaveBeenCalled();
    expect(mockPrisma.address.create).toHaveBeenCalled();
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { addressId: 16 } })
    );
  });

  it('treats a company reference to the address as sharing it too', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(profile({ addressId: 15, address: address() }));
    mockPrisma.companyAddress.count.mockResolvedValue(1);
    mockPrisma.address.create.mockResolvedValue(address({ id: 17 }));

    await request(app).patch('/api/users/me').set('Authorization', auth()).send({ address: addressBody() });

    expect(mockPrisma.address.update).not.toHaveBeenCalled();
    expect(mockPrisma.address.create).toHaveBeenCalled();
  });

  it('unlinks the address on null without deleting the shared row', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(profile({ addressId: 15, address: address() }));

    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth())
      .send({ address: null });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { addressId: null } })
    );
  });

  it('rejects a field the caller may not set on themselves', async () => {
    const res = await request(app).patch('/api/users/me').set('Authorization', auth()).send({ role: 'ADMIN' });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('role');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an empty patch rather than performing a no-op write', async () => {
    const res = await request(app).patch('/api/users/me').set('Authorization', auth()).send({});

    expect(res.status).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects a postal code that cannot belong to the named country', async () => {
    const res = await request(app)
      .patch('/api/users/me')
      .set('Authorization', auth())
      .send({ address: addressBody({ postalCode: 'ABC' }) });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.postalCode).toBeDefined();
    expect(mockPrisma.address.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed phone number', async () => {
    const res = await request(app).patch('/api/users/me').set('Authorization', auth()).send({ phone: '123' });

    expect(res.status).toBe(400);
    expect(res.body.error.fields.phone).toBeDefined();
  });
});

/* -------------------------------------------------------------------------- */
/* POST/DELETE /users/me/avatar                                               */
/* -------------------------------------------------------------------------- */

describe('POST /users/me/avatar', () => {
  it('stores the image under the caller id and points the row at it', async () => {
    let storedKey = null;
    mockPrisma.user.update.mockImplementation(({ data }) => {
      storedKey = data.avatarKey;
      return Promise.resolve(profile({ avatarKey: data.avatarKey }));
    });

    const res = await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', auth())
      .attach('avatar', PNG, 'photo.png');

    expect(res.status).toBe(200);
    // The folder comes from the TOKEN's subject, never from the request, so one
    // user cannot write into another's directory.
    expect(storedKey).toMatch(/^avatars\/11\/[0-9a-f]{32}\.png$/);
    expect(res.body.data.avatarUrl).toBe(`http://test.local/uploads/${storedKey}`);
    expect(uploadedFiles()).toHaveLength(1);
  });

  it('generates the filename instead of trusting the uploaded one', async () => {
    let storedKey = null;
    mockPrisma.user.update.mockImplementation(({ data }) => {
      storedKey = data.avatarKey;
      return Promise.resolve(profile({ avatarKey: data.avatarKey }));
    });

    await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', auth())
      // A genuine image whose NAME is a traversal attempt — the type check would
      // otherwise reject it first and prove nothing about the naming.
      .attach('avatar', PNG, { filename: '../../../server.png', contentType: 'image/png' });

    // A traversal attempt in `originalname` must not reach the filesystem, and no
    // part of the client's name may survive into the key.
    expect(storedKey).toMatch(/^avatars\/11\/[0-9a-f]{32}\.png$/);
    expect(storedKey).not.toContain('..');
    expect(uploadedFiles().every((f) => f.startsWith(UPLOAD_DIR))).toBe(true);
  });

  it('deletes the previous file once the new one is the picture of record', async () => {
    const previousDir = path.join(UPLOAD_DIR, 'avatars', String(USER_ID));
    fs.mkdirSync(previousDir, { recursive: true });
    const previous = path.join(previousDir, 'old.png');
    fs.writeFileSync(previous, PNG);

    mockPrisma.user.findUnique.mockResolvedValue(profile({ avatarKey: 'avatars/11/old.png' }));
    mockPrisma.user.update.mockImplementation(({ data }) =>
      Promise.resolve(profile({ avatarKey: data.avatarKey }))
    );

    const res = await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', auth())
      .attach('avatar', PNG, 'new.png');

    expect(res.status).toBe(200);
    expect(fs.existsSync(previous)).toBe(false);
    // Exactly one file survives: replacing a picture must not accumulate disk.
    expect(uploadedFiles()).toHaveLength(1);
  });

  it('removes the just-written file when the database write fails', async () => {
    mockPrisma.user.update.mockRejectedValue(new Error('db down'));

    const res = await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', auth())
      .attach('avatar', PNG, 'photo.png');

    expect(res.status).toBe(500);
    // Otherwise every failed save leaks a file nothing will ever reference.
    expect(uploadedFiles()).toHaveLength(0);
  });

  it('refuses a file that is not an accepted image type', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', auth())
      .attach('avatar', Buffer.from('not an image'), 'notes.txt');

    expect(res.status).toBe(415);
    expect(res.body.error.code).toBe('UNSUPPORTED_MEDIA_TYPE');
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
    expect(uploadedFiles()).toHaveLength(0);
  });

  it('refuses an image over the size cap and leaves nothing behind', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', auth())
      .attach('avatar', Buffer.alloc(3 * 1024 * 1024, 7), 'big.png');

    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('FILE_TOO_LARGE');
    expect(uploadedFiles()).toHaveLength(0);
  });

  it('rejects a request with no file attached', async () => {
    const res = await request(app).post('/api/users/me/avatar').set('Authorization', auth());

    expect(res.status).toBe(400);
    expect(res.body.error.fields.avatar).toBeDefined();
  });

  it('rejects extra form fields with a message that says so', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set('Authorization', auth())
      .field('notes', 'hello')
      .attach('avatar', PNG, 'photo.png');

    expect(res.status).toBe(400);
    expect(res.body.error.message).toContain('only the image');
  });

  it('rejects an unauthenticated upload before writing anything', async () => {
    const res = await request(app).post('/api/users/me/avatar').attach('avatar', PNG, 'photo.png');

    expect(res.status).toBe(401);
    expect(uploadedFiles()).toHaveLength(0);
  });
});

describe('DELETE /users/me/avatar', () => {
  it('clears the column and removes the file', async () => {
    const dir = path.join(UPLOAD_DIR, 'avatars', String(USER_ID));
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'old.png'), PNG);

    mockPrisma.user.findUnique.mockResolvedValue(profile({ avatarKey: 'avatars/11/old.png' }));
    mockPrisma.user.update.mockResolvedValue(profile({ avatarKey: null }));

    const res = await request(app).delete('/api/users/me/avatar').set('Authorization', auth());

    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBeNull();
    expect(mockPrisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { avatarKey: null } })
    );
    expect(uploadedFiles()).toHaveLength(0);
  });

  it('is idempotent when there is no picture to remove', async () => {
    const res = await request(app).delete('/api/users/me/avatar').set('Authorization', auth());

    // A second click is not an error: the caller's intent ("I have no picture")
    // is satisfied either way, and a 404 here would only look like a bug.
    expect(res.status).toBe(200);
    expect(res.body.data.avatarUrl).toBeNull();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});
