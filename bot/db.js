const sql = require('mssql');

const database = process.env.MSSQL_DATABASE || 'QuanLyChatBot';

function quoteName(name) {
  if (!/^[A-Za-z0-9_]+$/.test(name)) {
    throw new Error('Invalid SQL Server database name');
  }
  return `[${name}]`;
}

const baseConfig = {
  server: process.env.MSSQL_SERVER,
  port: Number(process.env.MSSQL_PORT || 1433),
  user: process.env.MSSQL_USER,
  password: process.env.MSSQL_PASSWORD,
  options: {
    encrypt: process.env.MSSQL_ENCRYPT === 'true',
    trustServerCertificate: process.env.MSSQL_TRUST_CERT !== 'false',
  },
  pool: {
    max: 10,
    min: 0,
    idleTimeoutMillis: 30000,
  },
};

let pool;
let initialized = false;

async function ensureDatabase() {
  const master = new sql.ConnectionPool({ ...baseConfig, database: 'master' });
  await master.connect();
  try {
    const dbName = quoteName(database);
    await master.request().query(`
      IF DB_ID(N'${database.replace(/'/g, "''")}') IS NULL
      BEGIN
        CREATE DATABASE ${dbName};
      END
    `);
  } finally {
    await master.close();
  }
}

async function ensureSchema(activePool) {
  await activePool.request().query(`
    IF OBJECT_ID(N'dbo.AppointmentRequests', N'U') IS NULL
    BEGIN
      CREATE TABLE dbo.AppointmentRequests (
        Id INT IDENTITY(1,1) PRIMARY KEY,
        Status NVARCHAR(30) NOT NULL CONSTRAINT DF_AppointmentRequests_Status DEFAULT N'pending',
        ConversationId NVARCHAR(100) NULL,
        Source NVARCHAR(50) NULL,

        MayTe NVARCHAR(50) NULL,
        Cccd NVARCHAR(20) NULL,
        TenBenhNhan NVARCHAR(255) NULL,
        NgaySinh NVARCHAR(20) NULL,
        NamSinh NVARCHAR(10) NULL,
        GioiTinh NVARCHAR(5) NULL,
        SoDienThoai NVARCHAR(20) NULL,
        DiaChi NVARCHAR(500) NULL,

        MaDichVu NVARCHAR(50) NOT NULL,
        TenDichVu NVARCHAR(255) NULL,
        LoaiDichVu NVARCHAR(100) NULL,
        NgayKham DATE NOT NULL,
        PhongKham NVARCHAR(100) NULL,
        DoiTuong NVARCHAR(20) NULL,
        LoaiGia NVARCHAR(20) NULL,
        Gia DECIMAL(18,2) NULL,

        CheckResult NVARCHAR(MAX) NULL,
        YoumedResponse NVARCHAR(MAX) NULL,
        MaDatCho NVARCHAR(50) NULL,
        STT NVARCHAR(20) NULL,
        GioKham NVARCHAR(50) NULL,

        AdminNote NVARCHAR(1000) NULL,
        CreatedAt DATETIME2 NOT NULL CONSTRAINT DF_AppointmentRequests_CreatedAt DEFAULT SYSUTCDATETIME(),
        UpdatedAt DATETIME2 NOT NULL CONSTRAINT DF_AppointmentRequests_UpdatedAt DEFAULT SYSUTCDATETIME(),
        ApprovedAt DATETIME2 NULL,
        ApprovedBy NVARCHAR(255) NULL
      );

      CREATE INDEX IX_AppointmentRequests_Status_CreatedAt
        ON dbo.AppointmentRequests(Status, CreatedAt DESC);
    END
  `);
}

async function getPool() {
  if (!pool) {
    await ensureDatabase();
    pool = new sql.ConnectionPool({ ...baseConfig, database });
    await pool.connect();
  }

  if (!initialized) {
    await ensureSchema(pool);
    initialized = true;
  }

  return pool;
}

module.exports = {
  sql,
  getPool,
};
