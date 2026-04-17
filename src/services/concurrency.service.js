// src/services/concurrency.service.js
// Unified concurrency control: optimistic locking, SELECT FOR UPDATE, and conflict resolution

const { withTransaction } = require("../db/pool");

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 100;

class ConcurrencyError extends Error {
  constructor(message, code = "CONCURRENCY_ERROR") {
    super(message);
    this.name = "ConcurrencyError";
    this.code = code;
    this.statusCode = 409;
  }
}

class OptimisticLockError extends ConcurrencyError {
  constructor(table, id, expectedVersion, actualVersion) {
    super(
      `Optimistic lock failed on ${table}: expected version ${expectedVersion}, got ${actualVersion}`,
      "OPTIMISTIC_LOCK_FAILED"
    );
    this.table = table;
    this.id = id;
    this.expectedVersion = expectedVersion;
    this.actualVersion = actualVersion;
  }
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withOptimisticRetry(operation, table, id, getVersion, maxRetries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (err) {
      if (err.code === "40001" || err.code === "20P01") {
        if (attempt === maxRetries) {
          throw new ConcurrencyError(
            `Optimistic lock conflict after ${maxRetries} retries on ${table} ${id}. Please retry.`,
            "OPTIMISTIC_LOCK_EXHAUSTED"
          );
        }
        await sleep(RETRY_DELAY_MS * attempt);
        continue;
      }
      throw err;
    }
  }
}

async function withRowLock(client, table, idColumn, idValue, callback) {
  const result = await client.query(
    `SELECT * FROM ${table} WHERE ${idColumn} = $1 FOR UPDATE`,
    [idValue]
  );
  return callback(result.rows[0]);
}

async function withPessimisticLock(client, table, idColumn, idValue, callback) {
  const result = await client.query(
    `SELECT * FROM ${table} WHERE ${idColumn} = $1 FOR UPDATE NOWAIT`,
    [idValue]
  );
  return callback(result.rows[0]);
}

async function updateWithOptimisticLock(client, table, id, version, setClause, values) {
  const result = await client.query(
    `UPDATE ${table} SET ${setClause}, version = version + 1, updated_at = NOW()
     WHERE id = $1 AND version = $2
     RETURNING *`,
    [id, version, ...values]
  );
  if (result.rowCount === 0) {
    const { rows } = await client.query(`SELECT version FROM ${table} WHERE id = $1`, [id]);
    const actualVersion = rows.length ? rows[0].version : null;
    throw new OptimisticLockError(table, id, version, actualVersion);
  }
  return result.rows[0];
}

async function updateWithPessimisticLock(client, table, idColumn, idValue, setClause, values) {
  const result = await client.query(
    `UPDATE ${table} SET ${setClause}, updated_at = NOW()
     WHERE ${idColumn} = $1
     RETURNING *`,
    [idValue, ...values]
  );
  if (result.rowCount === 0) {
    throw new ConcurrencyError(
      `Failed to update ${table} where ${idColumn} = ${idValue}`,
      "UPDATE_FAILED"
    );
  }
  return result.rows[0];
}

async function insertOrUpdateConflict(client, table, conflictTarget, updateColumns, insertValues, returning = "*") {
  const setParts = updateColumns.map((col, i) => `${col} = $${i + updateColumns.length + 1}`).join(", ");
  const result = await client.query(
    `INSERT INTO ${table} VALUES (${insertValues.map((_, i) => `$${i + 1}`).join(", ")})
     ON CONFLICT ${conflictTarget} DO UPDATE SET ${setParts}
     RETURNING ${returning}`,
    insertValues
  );
  return result.rows[0];
}

function buildOptimisticUpdateSet(columns) {
  return columns.map((col, i) => `${col} = $${i + 3}`).join(", ");
}

async function safeListingUpdate(client, listingId, sellerId, updates) {
  const cols = [];
  const vals = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && key !== "id" && key !== "version") {
      cols.push(`${key} = $${paramIdx}`);
      vals.push(value);
      paramIdx++;
    }
  }

  cols.push("version = version + 1");
  cols.push("updated_at = NOW()");

  const result = await client.query(
    `UPDATE listings SET ${cols.join(", ")}
     WHERE id = $${paramIdx} AND seller_id = $${paramIdx + 1} AND version = $${paramIdx + 2}
     RETURNING *`,
    [...vals, listingId, sellerId]
  );

  if (result.rowCount === 0) {
    const { rows } = await client.query(
      `SELECT version, status FROM listings WHERE id = $1`,
      [listingId]
    );
    if (!rows.length) {
      throw new ConcurrencyError("Listing not found", "NOT_FOUND");
    }
    throw new OptimisticLockError("listings", listingId, updates.version || "unknown", rows[0].version);
  }

  return result.rows[0];
}

async function safeEscrowUpdate(client, escrowId, buyerId, updates) {
  const cols = [];
  const vals = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && key !== "id" && key !== "version") {
      cols.push(`${key} = $${paramIdx}`);
      vals.push(value);
      paramIdx++;
    }
  }

  cols.push("version = version + 1");
  cols.push("updated_at = NOW()");

  const result = await client.query(
    `UPDATE escrows SET ${cols.join(", ")}
     WHERE id = $${paramIdx} AND buyer_id = $${paramIdx + 1} AND version = $${paramIdx + 2}
     RETURNING *`,
    [...vals, escrowId, buyerId]
  );

  if (result.rowCount === 0) {
    const { rows } = await client.query(
      `SELECT version, status FROM escrows WHERE id = $1`,
      [escrowId]
    );
    if (!rows.length) {
      throw new ConcurrencyError("Escrow not found", "NOT_FOUND");
    }
    throw new OptimisticLockError("escrows", escrowId, updates.version || "unknown", rows[0].version);
  }

  return result.rows[0];
}

async function safePaymentUpdate(client, paymentId, payerId, updates) {
  const cols = [];
  const vals = [];
  let paramIdx = 1;

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined && key !== "id" && key !== "version") {
      cols.push(`${key} = $${paramIdx}`);
      vals.push(value);
      paramIdx++;
    }
  }

  cols.push("version = version + 1");
  cols.push("updated_at = NOW()");

  const result = await client.query(
    `UPDATE payments SET ${cols.join(", ")}
     WHERE id = $${paramIdx} AND payer_id = $${paramIdx + 1} AND version = $${paramIdx + 2}
     RETURNING *`,
    [...vals, paymentId, payerId]
  );

  if (result.rowCount === 0) {
    const { rows } = await client.query(
      `SELECT version, status FROM payments WHERE id = $1`,
      [paymentId]
    );
    if (!rows.length) {
      throw new ConcurrencyError("Payment not found", "NOT_FOUND");
    }
    throw new OptimisticLockError("payments", paymentId, updates.version || "unknown", rows[0].version);
  }

  return result.rows[0];
}

async function withLockInTransaction(listingId, callback) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT l.*, u.email AS seller_email, u.name AS seller_name
       FROM listings l JOIN users u ON u.id=l.seller_id
       WHERE l.id=$1 AND l.status='active' FOR UPDATE`,
      [listingId]
    );
    if (!rows.length) {
      throw new ConcurrencyError("Listing not found or no longer active", "NOT_FOUND");
    }
    return callback(rows[0], client);
  });
}

async function withEscrowLockInTransaction(escrowId, callback) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM escrows WHERE id=$1 FOR UPDATE`,
      [escrowId]
    );
    if (!rows.length) {
      throw new ConcurrencyError("Escrow not found", "NOT_FOUND");
    }
    return callback(rows[0], client);
  });
}

async function acquireLock(listingId, buyerId, client) {
  const { rows } = await client.query(
    `SELECT id FROM listings WHERE id=$1 AND status='active' AND locked_buyer_id IS NULL FOR UPDATE NOWAIT`,
    [listingId]
  );
  if (!rows.length) {
    const { rows: existing } = await client.query(`SELECT locked_buyer_id FROM listings WHERE id=$1`, [listingId]);
    if (existing.length && existing[0].locked_buyer_id) {
      throw new ConcurrencyError("Another buyer has already locked in", "ALREADY_LOCKED");
    }
    throw new ConcurrencyError("Listing not available for lock-in", "NOT_AVAILABLE");
  }
  await client.query(
    `UPDATE listings SET locked_buyer_id=$1, locked_at=NOW(), status='locked', interest_count=interest_count+1, version=version+1 WHERE id=$2`,
    [buyerId, listingId]
  );
  return true;
}

module.exports = {
  ConcurrencyError,
  OptimisticLockError,
  MAX_RETRIES,
  withOptimisticRetry,
  withRowLock,
  withPessimisticLock,
  updateWithOptimisticLock,
  updateWithPessimisticLock,
  insertOrUpdateConflict,
  buildOptimisticUpdateSet,
  safeListingUpdate,
  safeEscrowUpdate,
  safePaymentUpdate,
  withLockInTransaction,
  withEscrowLockInTransaction,
  acquireLock,
  sleep,
};