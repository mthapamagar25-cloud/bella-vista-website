'use strict';
const mysql = require('mysql2/promise');
const { AsyncLocalStorage } = require('node:async_hooks');
const bookingColumns = ['id','token_hash','request_key','date','start','end','guests','name','phone','email','notes','menu','status','created','updated','version'];

function databaseConfig(overrides = {}) {
  const config = {
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    database: process.env.DB_NAME,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ...overrides
  };
  const names = {host:'DB_HOST',port:'DB_PORT',database:'DB_NAME',user:'DB_USER',password:'DB_PASSWORD'};
  const missing = Object.keys(names).filter(k => config[k] === undefined || config[k] === null || config[k] === '');
  if (missing.length) throw new Error('Hosted database configuration is missing: '+missing.map(k=>names[k]).join(', ')+'. Check GoDaddy Settings > Hosted Database > Open database guide.');
  config.port = Number(config.port);
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) throw new Error('DB_PORT must be a valid port number.');
  return config;
}

async function openDatabase(overrides, defaults) {
  const config = databaseConfig(overrides);
  const pool = mysql.createPool({...config,waitForConnections:true,connectionLimit:5,queueLimit:50,connectTimeout:10000,charset:'utf8mb4',dateStrings:true,supportBigNumbers:true});
  const context = new AsyncLocalStorage();
  const execute = async (sql, params=[]) => (await (context.getStore() || pool).execute(sql,params))[0];
  const db = {
    prepare(sql) {
      return {
        all: (...params) => execute(sql,params),
        get: async (...params) => (await execute(sql,params))[0],
        run: async (...params) => { const r=await execute(sql,params);return {changes:r.affectedRows,lastInsertRowid:r.insertId}; }
      };
    },
    async transaction(fn) {
      if (context.getStore()) return fn();
      const connection = await pool.getConnection();
      try {
        await connection.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
        await connection.beginTransaction();
        // Every capacity/settings/closure change takes the same database lock.
        // This protects bookings even when preview and production run together.
        await connection.execute('SELECT id FROM bv_booking_lock WHERE id=1 FOR UPDATE');
        const result = await context.run(connection,fn);
        await connection.commit();
        return result;
      } catch (error) {
        try { await connection.rollback(); } catch (_) {}
        throw error;
      } finally { connection.release(); }
    },
    close: () => pool.end()
  };
  try {
    const columnsFor = async table => {
      const [rows] = await pool.execute('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=?',[table]);
      return new Set(rows.map(row=>row.name));
    };
    const legacyColumns = await columnsFor('bv_bookings');
    const legacyCompatible = bookingColumns.every(name=>legacyColumns.has(name));
    const reservationColumns = await columnsFor('bv_reservations');
    if (legacyColumns.size && !legacyCompatible) {
      const [rows] = await pool.query('SELECT COUNT(*) AS n FROM bv_bookings');
      if (Number(rows[0].n)>0) throw new Error('The legacy bv_bookings table has records in an incompatible format. Export and migrate those records before starting this version. No legacy rows were changed.');
    }
    // Preserve an existing compatible v1.1.0 store. An empty legacy payload
    // table is left intact while the new application uses bv_reservations.
    const bookingTable = reservationColumns.size ? 'bv_reservations' : legacyCompatible ? 'bv_bookings' : 'bv_reservations';
    db.bookingsTable = bookingTable;
    const tables = [
      'CREATE TABLE IF NOT EXISTS bv_booking_lock (id TINYINT PRIMARY KEY) ENGINE=InnoDB',
      'CREATE TABLE IF NOT EXISTS bv_settings (id TINYINT PRIMARY KEY, `value` LONGTEXT NOT NULL, version INT NOT NULL DEFAULT 1) ENGINE=InnoDB',
      `CREATE TABLE IF NOT EXISTS ${bookingTable} (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
        request_key CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,
        \`date\` CHAR(10) NOT NULL, \`start\` INT NOT NULL, \`end\` INT NOT NULL, guests INT NOT NULL,
        name VARCHAR(100) NOT NULL, phone VARCHAR(40) NOT NULL, email VARCHAR(254) NOT NULL,
        notes TEXT NOT NULL, menu VARCHAR(100) NOT NULL, status VARCHAR(16) NOT NULL,
        created BIGINT NOT NULL, updated BIGINT NOT NULL, version INT NOT NULL DEFAULT 1,
        INDEX bv_booking_day (\`date\`,status,\`start\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS bv_closures (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        \`date\` CHAR(10) NOT NULL, \`start\` INT NOT NULL, \`end\` INT NOT NULL, reason VARCHAR(120) NOT NULL,
        INDEX bv_closure_day (\`date\`,\`start\`)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS bv_sessions (
        token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
        csrf CHAR(43) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        expires BIGINT NOT NULL, fingerprint CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL
      ) ENGINE=InnoDB`,
      'CREATE TABLE IF NOT EXISTS bv_limits (`key` VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY, `count` INT NOT NULL, resets BIGINT NOT NULL, INDEX bv_limit_expiry (resets)) ENGINE=InnoDB',
      'CREATE TABLE IF NOT EXISTS bv_audit (id BIGINT AUTO_INCREMENT PRIMARY KEY, `at` BIGINT NOT NULL, action VARCHAR(40) NOT NULL, ref VARCHAR(100) NOT NULL) ENGINE=InnoDB'
    ];
    for (const sql of tables) await pool.query(sql);
    const required = {
      [bookingTable]:bookingColumns,
      bv_booking_lock:['id'],bv_settings:['id','value','version'],
      bv_closures:['id','date','start','end','reason'],
      bv_sessions:['token','csrf','expires','fingerprint'],
      bv_limits:['key','count','resets'],bv_audit:['id','at','action','ref']
    };
    for (const [table,names] of Object.entries(required)) {
      const found=await columnsFor(table),missing=names.filter(name=>!found.has(name));
      if(missing.length) throw new Error(`Database table ${table} is missing columns: ${missing.join(', ')}. Existing tables have been preserved.`);
    }
    await pool.execute('INSERT INTO bv_booking_lock(id) VALUES(1) ON DUPLICATE KEY UPDATE id=id');
    await pool.execute('INSERT INTO bv_settings(id,`value`) VALUES(1,?) ON DUPLICATE KEY UPDATE id=id',[JSON.stringify(defaults)]);
    return db;
  } catch (error) { await pool.end();throw error; }
}
module.exports = {openDatabase,databaseConfig};
