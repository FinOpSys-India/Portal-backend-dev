'use strict';

const { toPerson } = require('./projectDto');

/**
 * Response shapes for the email screen.
 *
 * Two rules carried over from projectDocumentDto, because the same two facts are
 * true here:
 *
 *   1. `size_bytes` is BIGINT, so Prisma hands back a JavaScript BigInt — and
 *      `JSON.stringify` THROWS on a BigInt rather than rendering it. Every size
 *      that leaves this file goes through `toBytes`.
 *
 *   2. `file_key` never leaves this file, and is not even selected by the
 *      repository's read paths. These files are not served statically; what the
 *      client gets is a download URL pointing at the authorized endpoint.
 */

/** A BIGINT column as a JSON number. See rule 1 above. */
function toBytes(value) {
  if (value === null || value === undefined) return 0;
  return Number(value);
}

/**
 * One person in the recipient picker.
 *
 * Built on `toPerson` rather than beside it, so a name is spelled and an avatar
 * is turned into a URL in exactly one place across the whole API.
 *
 * `group` is the addition, and it is what the picker renders its two sections
 * from: CUSTOMER for the owner and the teammates, SPECIALIST for the three
 * service lines. `roleLabel` says which KIND — "Owner", "Team", or the
 * specializations that specialist covers on THIS company — because a list of
 * names with no roles beside them cannot be picked from with any confidence.
 */
function toRecipientOption(person, { group, roleLabel, specializations = [] }) {
  return {
    ...toPerson(person),
    group,
    roleLabel,
    // Always an array, even when it holds one entry, so a client never has to
    // special-case the specialist who covers a single line.
    specializations,
    companyId: person.companyId ?? null,
    companyName: person.companyName ?? null,
  };
}

/**
 * The customer list — the company's owner and its teammates.
 *
 * The company is echoed at the top rather than only on each row because every
 * row belongs to it, and a client rendering a heading should not have to reach
 * into `customers[0]` for the name (which is empty the moment the list is).
 * It stays on the rows as well, so a row detached from this envelope — dropped
 * into a chip, a table, a selected-recipients box — still says which account it
 * came from.
 */
function toCustomerRecipientList({ company, customers }) {
  return {
    companyId: company.id,
    companyName: company.companyName,
    customers,
    total: customers.length,
  };
}

/** The specialist list. Same envelope, different array — see above. */
function toSpecialistRecipientList({ company, specialists }) {
  return {
    companyId: company.id,
    companyName: company.companyName,
    specialists,
    total: specialists.length,
  };
}

/**
 * The accounting manager list. Same envelope again.
 *
 * An ARRAY even though the schema allows only one, because the three recipient
 * endpoints are one contract seen three times: a client that had to unwrap a
 * bare object here would special-case a third of its picker for no reason the
 * screen can see, and would break the day a company gains a second manager.
 * Nobody staffed is `[]` and `total: 0` — never null, never a 404.
 */
function toAccountingManagerRecipientList({ company, accountingManagers }) {
  return {
    companyId: company.id,
    companyName: company.companyName,
    accountingManagers,
    total: accountingManagers.length,
  };
}

/** One attachment as the client sees it. */
function toAttachment(attachment) {
  return {
    id: attachment.id,
    // `fileName` rather than `originalName`: the column is named for what it
    // holds (as opposed to the generated storage name), but from the other side
    // of the screen there is only one name and this is it.
    fileName: attachment.originalName,
    mimeType: attachment.mimeType,
    sizeBytes: toBytes(attachment.sizeBytes),
  };
}

/** A recipient row: the person, plus which header they were on. */
function toRecipient(row) {
  return { ...toPerson(row.user), recipientType: row.recipientType };
}

/**
 * One message in full.
 *
 * `from` is BUILT FROM THE JOINED SENDER, not from a stored address — see the
 * note at the top of emailRepository for why no such column exists. Null when
 * the composer's account has since been deleted: the FK is SET NULL, so the
 * message outlives the attribution rather than the other way round.
 *
 * Recipients are split into `to` / `cc` / `bcc` here rather than handed over as
 * one list with a type on each row. That is the shape a compose form binds to —
 * three separate fields — and partitioning in the client would mean every
 * consumer re-writing the same three filters.
 */
function toMessage(message) {
  const recipients = (message.recipients ?? []).map(toRecipient);

  return {
    id: message.id,
    companyId: message.companyId,
    companyName: message.company?.companyName ?? null,
    from: toPerson(message.sender),
    to: recipients.filter((r) => r.recipientType === 'TO'),
    cc: recipients.filter((r) => r.recipientType === 'CC'),
    bcc: recipients.filter((r) => r.recipientType === 'BCC'),
    subject: message.subject,
    bodyHtml: message.bodyHtml,
    attachments: (message.attachments ?? []).map(toAttachment),
    status: message.status,
    // Only ever populated on a FAILED row. Returned rather than hidden because
    // the screen's retry button is useless without telling the user why the last
    // attempt did not work.
    errorMessage: message.errorMessage ?? null,
    sentAt: message.sentAt,
    createdAt: message.createdAt,
    updatedAt: message.updatedAt,
  };
}

/*
 * There is no `toAttachmentResult` here any more. It shaped the response of
 * `POST /emails/:id/attachments/confirm`, which no longer exists: the files are
 * measured and recorded inside `POST /emails`, so the only place an attachment is
 * ever returned is on the message that carries it — through `toMessage` above.
 */

module.exports = {
  toBytes,
  toRecipientOption,
  toCustomerRecipientList,
  toSpecialistRecipientList,
  toAccountingManagerRecipientList,
  toAttachment,
  toRecipient,
  toMessage,
};
