const path = require('path');
const { sql, getPool } = require('./db');
const youmed = require('./youmed');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCCD_RE = /^\d{12}$/;
const PHONE_RE = /^(0|\+84)\d{9,10}$/;

function clean(value) {
  return typeof value === 'string' ? value.trim() : value;
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function badRequest(res, message) {
  return res.status(400).json({ error: message });
}

function normalizeAppointment(body) {
  return {
    conversationId: cleanText(body.conversationId || body.conversation_id || ''),
    source: cleanText(body.source || 'web_form'),
    mayte: cleanText(body.mayte || ''),
    cccd: cleanText(body.cccd || ''),
    tenbenhnhan: cleanText(body.tenbenhnhan || ''),
    ngaysinh: cleanText(body.ngaysinh || ''),
    namsinh: cleanText(body.namsinh || ''),
    gioitinh: cleanText(body.gioitinh || ''),
    sodienthoai: cleanText(body.sodienthoai || ''),
    diachi: cleanText(body.diachi || ''),
    madichvu: cleanText(body.madichvu || ''),
    tendichvu: cleanText(body.tendichvu || body.tendichvu_his || body.tendichvu_ym || ''),
    loaidichvu: cleanText(body.loaidichvu || ''),
    ngaykham: cleanText(body.ngaykham || ''),
    phongkham: cleanText(body.phongkham || ''),
    doituong: cleanText(body.doituong || ''),
    loaigia: cleanText(body.loaigia || ''),
    gia: body.gia === '' || body.gia === undefined ? null : Number(body.gia),
  };
}

function validateAppointment(data) {
  if (!data.mayte) {
    if (!data.tenbenhnhan) return 'Thieu ho ten benh nhan';
    if (!data.gioitinh) return 'Thieu gioi tinh';
    if (!data.ngaysinh && !data.namsinh) return 'Thieu ngay sinh hoac nam sinh';
    if (!data.sodienthoai) return 'Thieu so dien thoai';
  }
  if (data.cccd && !CCCD_RE.test(data.cccd)) return 'CCCD phai co 12 chu so';
  if (data.sodienthoai && !PHONE_RE.test(data.sodienthoai)) return 'So dien thoai khong hop le';
  if (!data.madichvu || !/^\d+$/.test(data.madichvu)) return 'Thieu ma dich vu';
  if (!DATE_RE.test(data.ngaykham)) return 'Ngay kham phai co dinh dang yyyy-mm-dd';
  if (!data.doituong) return 'Thieu doi tuong';
  if (!data.loaigia) return 'Thieu loai gia';
  if (data.gia !== null && Number.isNaN(data.gia)) return 'Gia khong hop le';
  return null;
}

function buildCreatePatientPayload(row) {
  const payload = {
    tenbenhnhan: row.TenBenhNhan,
    gioitinh: row.GioiTinh,
    sodienthoai: row.SoDienThoai,
    cccd: row.Cccd || undefined,
  };
  if (row.NgaySinh) payload.ngaysinh = row.NgaySinh;
  if (row.NamSinh) payload.namsinh = row.NamSinh;
  if (row.DiaChi) payload.sonha = row.DiaChi;
  return payload;
}

function buildYoumedPayload(row) {
  return {
    mayte: row.MayTe,
    madichvu: row.MaDichVu,
    ngaykham: row.NgayKham instanceof Date ? row.NgayKham.toISOString().slice(0, 10) : String(row.NgayKham).slice(0, 10),
    loaigia: row.LoaiGia,
    doituong: row.DoiTuong,
  };
}

function buildMissingMayTeCheckResult() {
  return {
    code: 'pending_patient',
    message: 'Benh nhan moi chua co ma y te. Vui long bam Duyet de tao ho so, sau do he thong se tu kiem tra va dat kham.',
  };
}

async function getAppointment(id) {
  const pool = await getPool();
  const result = await pool.request()
    .input('Id', sql.Int, Number(id))
    .query('SELECT * FROM dbo.AppointmentRequests WHERE Id = @Id');
  return result.recordset[0];
}

async function listAppointments(status) {
  const pool = await getPool();
  const request = pool.request();
  let where = '';
  if (status) {
    where = 'WHERE Status = @Status';
    request.input('Status', sql.NVarChar(30), status);
  }
  const result = await request.query(`
    SELECT TOP 200 *
    FROM dbo.AppointmentRequests
    ${where}
    ORDER BY CreatedAt DESC
  `);
  return result.recordset;
}

async function insertAppointment(data, checkResult) {
  const pool = await getPool();
  const result = await pool.request()
    .input('ConversationId', sql.NVarChar(100), data.conversationId || null)
    .input('Source', sql.NVarChar(50), data.source || 'web_form')
    .input('MayTe', sql.NVarChar(50), data.mayte)
    .input('Cccd', sql.NVarChar(20), data.cccd || null)
    .input('TenBenhNhan', sql.NVarChar(255), data.tenbenhnhan || null)
    .input('NgaySinh', sql.NVarChar(20), data.ngaysinh || null)
    .input('NamSinh', sql.NVarChar(10), data.namsinh || null)
    .input('GioiTinh', sql.NVarChar(5), data.gioitinh || null)
    .input('SoDienThoai', sql.NVarChar(20), data.sodienthoai || null)
    .input('DiaChi', sql.NVarChar(500), data.diachi || null)
    .input('MaDichVu', sql.NVarChar(50), data.madichvu)
    .input('TenDichVu', sql.NVarChar(255), data.tendichvu || null)
    .input('LoaiDichVu', sql.NVarChar(100), data.loaidichvu || null)
    .input('NgayKham', sql.Date, data.ngaykham)
    .input('PhongKham', sql.NVarChar(100), data.phongkham || null)
    .input('DoiTuong', sql.NVarChar(20), data.doituong)
    .input('LoaiGia', sql.NVarChar(20), data.loaigia)
    .input('Gia', sql.Decimal(18, 2), data.gia)
    .input('CheckResult', sql.NVarChar(sql.MAX), checkResult ? JSON.stringify(checkResult) : null)
    .query(`
      INSERT INTO dbo.AppointmentRequests (
        ConversationId, Source, MayTe, Cccd, TenBenhNhan, NgaySinh, NamSinh, GioiTinh,
        SoDienThoai, DiaChi, MaDichVu, TenDichVu, LoaiDichVu, NgayKham, PhongKham,
        DoiTuong, LoaiGia, Gia, CheckResult
      )
      OUTPUT INSERTED.*
      VALUES (
        @ConversationId, @Source, @MayTe, @Cccd, @TenBenhNhan, @NgaySinh, @NamSinh, @GioiTinh,
        @SoDienThoai, @DiaChi, @MaDichVu, @TenDichVu, @LoaiDichVu, @NgayKham, @PhongKham,
        @DoiTuong, @LoaiGia, @Gia, @CheckResult
      )
    `);
  return result.recordset[0];
}

async function createPendingAppointment(body) {
  const data = normalizeAppointment(body || {});
  const validationError = validateAppointment(data);
  if (validationError) {
    const error = new Error(validationError);
    error.statusCode = 400;
    throw error;
  }

  let checkResult = null;
  if (data.mayte) {
    const checkPayload = {
      mayte: data.mayte,
      madichvu: data.madichvu,
      ngaykham: data.ngaykham,
      loaigia: String(data.loaigia),
      doituong: String(data.doituong),
    };
    checkResult = await youmed.checkAppointment(checkPayload);
    if (checkResult.code !== 'success' || checkResult.data !== true) {
      const message = checkResult.message && checkResult.message !== 'success'
        ? checkResult.message
        : 'Lich kham khong con kha dung. Vui long chon dich vu hoac ngay kham khac.';
      const error = new Error(message);
      error.statusCode = 409;
      error.checkResult = checkResult;
      throw error;
    }
  }

  return insertAppointment(data, checkResult);
}

async function updateCheckResult(id, status, checkResult) {
  const pool = await getPool();
  await pool.request()
    .input('Id', sql.Int, Number(id))
    .input('Status', sql.NVarChar(30), status)
    .input('CheckResult', sql.NVarChar(sql.MAX), JSON.stringify(checkResult))
    .query(`
      UPDATE dbo.AppointmentRequests
      SET Status = @Status, CheckResult = @CheckResult, UpdatedAt = SYSUTCDATETIME()
      WHERE Id = @Id
    `);
}

async function markRejected(id, note, admin) {
  const pool = await getPool();
  await pool.request()
    .input('Id', sql.Int, Number(id))
    .input('AdminNote', sql.NVarChar(1000), note || null)
    .input('ApprovedBy', sql.NVarChar(255), admin || null)
    .query(`
      UPDATE dbo.AppointmentRequests
      SET Status = N'rejected', AdminNote = @AdminNote, ApprovedBy = @ApprovedBy,
          UpdatedAt = SYSUTCDATETIME()
      WHERE Id = @Id
    `);
}

async function markSubmitted(id, youmedResponse, admin) {
  const hangcho = youmedResponse && youmedResponse.data && youmedResponse.data.hangcho ? youmedResponse.data.hangcho : {};
  const pool = await getPool();
  await pool.request()
    .input('Id', sql.Int, Number(id))
    .input('YoumedResponse', sql.NVarChar(sql.MAX), JSON.stringify(youmedResponse))
    .input('MaDatCho', sql.NVarChar(50), hangcho.madatcho || null)
    .input('STT', sql.NVarChar(20), hangcho.stt || null)
    .input('GioKham', sql.NVarChar(50), hangcho.giokham || null)
    .input('PhongKham', sql.NVarChar(100), hangcho.phongkham || null)
    .input('ApprovedBy', sql.NVarChar(255), admin || null)
    .query(`
      UPDATE dbo.AppointmentRequests
      SET Status = N'submitted', YoumedResponse = @YoumedResponse, MaDatCho = @MaDatCho,
          STT = @STT, GioKham = @GioKham, PhongKham = COALESCE(@PhongKham, PhongKham),
          ApprovedAt = SYSUTCDATETIME(), ApprovedBy = @ApprovedBy, UpdatedAt = SYSUTCDATETIME()
      WHERE Id = @Id
    `);
}

async function updatePatientAfterCreate(id, mayte, youmedResponse) {
  const pool = await getPool();
  await pool.request()
    .input('Id', sql.Int, Number(id))
    .input('MayTe', sql.NVarChar(50), mayte)
    .input('YoumedResponse', sql.NVarChar(sql.MAX), JSON.stringify(youmedResponse))
    .query(`
      UPDATE dbo.AppointmentRequests
      SET MayTe = @MayTe, YoumedResponse = @YoumedResponse, UpdatedAt = SYSUTCDATETIME()
      WHERE Id = @Id
    `);
}

async function markFailed(id, response) {
  const pool = await getPool();
  await pool.request()
    .input('Id', sql.Int, Number(id))
    .input('YoumedResponse', sql.NVarChar(sql.MAX), JSON.stringify(response))
    .query(`
      UPDATE dbo.AppointmentRequests
      SET Status = N'failed', YoumedResponse = @YoumedResponse, UpdatedAt = SYSUTCDATETIME()
      WHERE Id = @Id
    `);
}

function adminNameFromRequest(req) {
  const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
  const [login] = Buffer.from(b64auth, 'base64').toString().split(':');
  return login || null;
}

function registerAppointmentRoutes(app, { auth, sendMessage }) {
  app.get('/dat-kham', (req, res) => {
    res.send(`
      <!doctype html>
      <html lang="vi">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Đặt lịch khám</title>
        <style>
          body{font-family:Arial,sans-serif;background:#f5f7fb;color:#172033;margin:0;display:grid;place-items:center;min-height:100vh}
          main{max-width:560px;background:#fff;border:1px solid #d8deea;border-radius:8px;padding:24px;line-height:1.5}
          h1{font-size:22px;margin:0 0 10px}
        </style>
      </head>
      <body>
        <main>
          <h1>Đặt lịch khám qua chatbot</h1>
          <p>Vui lòng mở khung chat và gõ <strong>đặt lịch khám</strong>. Bot sẽ hỏi từng thông tin cần thiết và gửi yêu cầu chờ nhân viên duyệt.</p>
        </main>
      </body>
      </html>
    `);
  });

  app.get('/DatKhamAdmin', auth, (req, res) => {
    res.sendFile(path.join(__dirname, 'Documents/DatKhamAdmin.html'));
  });

  app.get('/api/appointments/services', async (req, res) => {
    try {
      res.json(await youmed.getServices());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/appointments/patient', async (req, res) => {
    try {
      const mayte = clean(req.query.mayte || '');
      const cccd = clean(req.query.cccd || '');
      if (!mayte && !cccd) return badRequest(res, 'Can mayte hoac cccd');
      if (cccd && !CCCD_RE.test(cccd)) return badRequest(res, 'CCCD phai co 12 chu so');
      res.json(await youmed.getPatient({ mayte, cccd }));
    } catch (err) {
      const status = err.response && err.response.status ? err.response.status : 502;
      const payload = err.response && err.response.data ? err.response.data : null;
      res.status(status).json(payload || { code: 'fail', message: 'Khong tra cuu duoc thong tin benh nhan' });
    }
  });

  app.post('/api/appointments', async (req, res) => {
    try {
      const row = await createPendingAppointment(req.body || {});
      if (sendMessage && row.ConversationId) {
        await sendMessage(row.ConversationId, `Yeu cau dat lich #${row.Id} da duoc ghi nhan va dang cho admin duyet.`);
      }
      res.status(201).json({ appointment: row });
    } catch (err) {
      res.status(err.statusCode || 500).json({ error: err.message, checkResult: err.checkResult });
    }
  });

  app.use('/api/admin/appointments', auth);

  app.get('/api/admin/appointments', async (req, res) => {
    try {
      res.json({ appointments: await listAppointments(clean(req.query.status || 'pending')) });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/appointments/:id', async (req, res) => {
    try {
      const row = await getAppointment(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      res.json({ appointment: row });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/appointments/:id/check', async (req, res) => {
    try {
      const row = await getAppointment(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (!row.MayTe) {
        const checkResult = buildMissingMayTeCheckResult();
        await updateCheckResult(row.Id, 'pending', checkResult);
        return res.json({ checkResult });
      }
      const checkResult = await youmed.checkAppointment(buildYoumedPayload(row));
      await updateCheckResult(row.Id, checkResult.code === 'success' && checkResult.data === true ? 'pending' : 'failed', checkResult);
      res.json({ checkResult });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/appointments/:id/approve', async (req, res) => {
    try {
      const row = await getAppointment(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      if (row.Status === 'submitted') return res.json({ appointment: row, alreadySubmitted: true });

      let activeRow = row;
      if (!activeRow.MayTe) {
        const createPatientResponse = await youmed.createPatient(buildCreatePatientPayload(activeRow));
        const mayte = createPatientResponse && createPatientResponse.data && createPatientResponse.data.benhnhan
          ? createPatientResponse.data.benhnhan.mayte
          : null;
        if (createPatientResponse.code !== 'success' || !mayte) {
          await markFailed(activeRow.Id, createPatientResponse);
          return res.status(409).json({ error: 'Tao benh nhan moi that bai', youmedResponse: createPatientResponse });
        }
        await updatePatientAfterCreate(activeRow.Id, mayte, createPatientResponse);
        activeRow = await getAppointment(activeRow.Id);
      }

      const payload = buildYoumedPayload(activeRow);
      const checkResult = await youmed.checkAppointment(payload);
      if (checkResult.code !== 'success' || checkResult.data !== true) {
        await updateCheckResult(activeRow.Id, 'failed', checkResult);
        return res.status(409).json({ error: 'Check dat kham that bai', checkResult });
      }

      const youmedResponse = await youmed.bookAppointment(payload);
      if (youmedResponse.code !== 'success') {
        await markFailed(activeRow.Id, youmedResponse);
        return res.status(409).json({ error: 'Dat kham that bai', youmedResponse });
      }

      await markSubmitted(activeRow.Id, youmedResponse, adminNameFromRequest(req));
      const updated = await getAppointment(activeRow.Id);
      if (sendMessage && activeRow.ConversationId) {
        const hangcho = youmedResponse.data && youmedResponse.data.hangcho;
        const text = hangcho
          ? `Lich kham cua ban da duoc xac nhan. Ma dat cho: ${hangcho.madatcho}, STT: ${hangcho.stt}, gio: ${hangcho.giokham}, phong: ${hangcho.phongkham}.`
          : 'Lich kham cua ban da duoc xac nhan.';
        await sendMessage(activeRow.ConversationId, text);
      }
      res.json({ appointment: updated, youmedResponse });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/appointments/:id/reject', async (req, res) => {
    try {
      const row = await getAppointment(req.params.id);
      if (!row) return res.status(404).json({ error: 'Not found' });
      await markRejected(row.Id, clean(req.body && req.body.note), adminNameFromRequest(req));
      if (sendMessage && row.ConversationId) {
        await sendMessage(row.ConversationId, 'Yeu cau dat lich cua ban chua duoc duyet. Vui long cho nhan vien lien he ho tro.');
      }
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

registerAppointmentRoutes.createPendingAppointment = createPendingAppointment;

module.exports = registerAppointmentRoutes;
