const youmed = require('./youmed');
const { createPendingAppointment } = require('./appointmentRoutes');

const sessions = new Map();
const SESSION_TTL_MS = 30 * 60 * 1000;

function normalize(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd');
}

function parseChoice(content, max) {
  const value = normalize(content);
  const number = Number.parseInt(value, 10);
  if (number >= 1 && number <= max) return number;
  return null;
}

function isCancel(content) {
  return ['huy', 'huy dat lich', 'cancel', 'thoat', 'dung lai'].includes(normalize(content));
}

function isSkip(content) {
  return ['bo qua', 'khong co', 'khong', 'chua co', 'skip'].includes(normalize(content));
}

function cleanExpiredSessions() {
  const now = Date.now();
  for (const [conversationId, session] of sessions.entries()) {
    if (now - session.updatedAt > SESSION_TTL_MS) {
      sessions.delete(conversationId);
    }
  }
}

function startSession(conversationId) {
  const session = {
    step: 'identity_type',
    data: {
      conversationId,
      source: 'chatbot',
    },
    services: [],
    dateOptions: [],
    updatedAt: Date.now(),
  };
  sessions.set(conversationId, session);
  return session;
}

function touch(session) {
  session.updatedAt = Date.now();
}

function patientSummary(patient) {
  return [
    `Họ tên: ${patient.tenbenhnhan || ''}`,
    `Mã y tế: ${patient.mayte || ''}`,
    `Ngày sinh: ${patient.ngaysinh || patient.namsinh || ''}`,
    `SĐT: ${patient.sodienthoai || ''}`,
    `CCCD: ${patient.cccd || ''}`,
  ].filter(Boolean).join('\n');
}

function applyPatient(session, patient) {
  Object.assign(session.data, {
    mayte: patient.mayte || '',
    cccd: patient.cccd || session.data.cccd || '',
    tenbenhnhan: patient.tenbenhnhan || '',
    ngaysinh: patient.ngaysinh || '',
    namsinh: patient.namsinh || '',
    gioitinh: patient.gioitinh || '',
    sodienthoai: patient.sodienthoai || '',
    diachi: patient.diachi || '',
  });
}

async function askService(session, sendMessage) {
  const response = await youmed.getServices();
  const services = response.data && response.data.dichvus ? response.data.dichvus : [];
  session.services = services.filter(s => s && s.madichvu && Array.isArray(s.lichkhams) && s.lichkhams.length > 0);
  if (!session.services.length) {
    session.step = 'done';
    await sendMessage(session.data.conversationId, 'Hiện chưa tải được danh sách lịch khám. Vui lòng thử lại sau hoặc gặp nhân viên hỗ trợ.');
    return;
  }

  session.step = 'service';
  const list = session.services.map((s, index) => {
    const price = Number(s.gia || 0).toLocaleString('vi-VN');
    return `${index + 1}. ${s.loaidichvu} - ${s.tendichvu_his || s.tendichvu_ym} (${price}đ)`;
  }).join('\n');

  await sendMessage(session.data.conversationId, `Anh/chị muốn đặt dịch vụ nào?\n${list}\n\nVui lòng trả lời bằng số thứ tự.`);
}

async function askDate(session, sendMessage) {
  session.step = 'date';
  const service = session.selectedService;
  session.dateOptions = (service.lichkhams || []).slice(0, 20);
  const list = session.dateOptions.map((item, index) => `${index + 1}. ${item.ngaykham} - ${item.phongkham}`).join('\n');
  await sendMessage(session.data.conversationId, `Anh/chị chọn ngày/phòng khám:\n${list}\n\nVui lòng trả lời bằng số thứ tự.`);
}

function buildSummary(session) {
  const data = session.data;
  return [
    'Anh/chị kiểm tra lại thông tin đặt lịch:',
    '',
    `Họ tên: ${data.tenbenhnhan || ''}`,
    `Giới tính: ${data.gioitinh === 'T' ? 'Nam' : data.gioitinh === 'G' ? 'Nữ' : data.gioitinh || ''}`,
    `Ngày/năm sinh: ${data.ngaysinh || data.namsinh || ''}`,
    `SĐT: ${data.sodienthoai || ''}`,
    `CCCD: ${data.cccd || 'Chưa cung cấp'}`,
    `Mã y tế: ${data.mayte || 'Bệnh nhân mới/chưa có mã y tế'}`,
    `Dịch vụ: ${data.tendichvu || ''}`,
    `Ngày khám: ${data.ngaykham || ''}`,
    `Phòng khám dự kiến: ${data.phongkham || ''}`,
    '',
    'Trả lời 1 để gửi yêu cầu chờ duyệt, hoặc 2 để hủy.'
  ].join('\n');
}

async function saveRequest(session, sendMessage) {
  try {
    const row = await createPendingAppointment(session.data);
    sessions.delete(session.data.conversationId);
    await sendMessage(
      session.data.conversationId,
      `Đã ghi nhận yêu cầu đặt lịch #${row.Id}. Nhân viên sẽ kiểm tra và duyệt trước khi lịch được gửi vào hệ thống.`
    );
  } catch (err) {
    if (err.statusCode === 409 && session.data.mayte) {
      await sendMessage(session.data.conversationId, `${err.message}\nVui lòng chọn ngày khác.`);
      await askDate(session, sendMessage);
      return;
    }
    await sendMessage(session.data.conversationId, `Chưa gửi được yêu cầu: ${err.message}. Vui lòng kiểm tra lại thông tin hoặc gặp nhân viên hỗ trợ.`);
  }
}

async function handleActiveSession(session, content, sendMessage) {
  touch(session);

  if (isCancel(content)) {
    sessions.delete(session.data.conversationId);
    await sendMessage(session.data.conversationId, 'Đã hủy phiên đặt lịch. Khi cần đặt lại, anh/chị gõ "đặt lịch khám".');
    return true;
  }

  switch (session.step) {
    case 'identity_type': {
      const choice = parseChoice(content, 2);
      if (!choice) {
        await sendMessage(session.data.conversationId, 'Vui lòng chọn 1 hoặc 2:\n1. Đã từng khám/có mã y tế hoặc CCCD\n2. Bệnh nhân mới/chưa có mã y tế');
        return true;
      }
      if (choice === 1) {
        session.step = 'identifier';
        await sendMessage(session.data.conversationId, 'Anh/chị vui lòng nhập mã y tế hoặc CCCD để bot thử tra thông tin. Nếu không tìm thấy vẫn có thể tiếp tục khai thông tin đặt lịch.');
      } else {
        session.step = 'cccd';
        await sendMessage(session.data.conversationId, 'Anh/chị vui lòng nhập CCCD 12 số. Nếu chưa có/không nhớ, gõ "không có".');
      }
      return true;
    }

    case 'identifier': {
      const value = content.trim();
      try {
        const isCccd = /^\d{12}$/.test(value);
        const response = await youmed.getPatient({ mayte: isCccd ? '' : value, cccd: isCccd ? value : '' });
        if (response.code === 'success' && response.data && response.data.benhnhan) {
          applyPatient(session, response.data.benhnhan);
          session.step = 'patient_confirm';
          await sendMessage(session.data.conversationId, `Bot tìm thấy hồ sơ:\n${patientSummary(response.data.benhnhan)}\n\nThông tin này đúng không?\n1. Đúng\n2. Nhập lại mã/CCCD\n3. Không đúng, tiếp tục khai như bệnh nhân mới`);
        } else {
          session.step = 'patient_not_found';
          await sendMessage(session.data.conversationId, 'Không tìm thấy hồ sơ với thông tin vừa nhập.\n1. Nhập lại mã y tế/CCCD\n2. Tiếp tục khai thông tin để nhân viên duyệt');
        }
      } catch (err) {
        session.step = 'patient_not_found';
        await sendMessage(session.data.conversationId, 'Không tìm thấy hồ sơ với thông tin vừa nhập.\n1. Nhập lại mã y tế/CCCD\n2. Tiếp tục khai thông tin để nhân viên duyệt');
      }
      return true;
    }

    case 'patient_confirm': {
      const choice = parseChoice(content, 3);
      if (choice === 1) {
        await askService(session, sendMessage);
      } else if (choice === 2) {
        session.step = 'identifier';
        await sendMessage(session.data.conversationId, 'Anh/chị nhập lại mã y tế hoặc CCCD.');
      } else if (choice === 3) {
        session.data.mayte = '';
        session.step = 'cccd';
        await sendMessage(session.data.conversationId, 'Anh/chị vui lòng nhập CCCD 12 số. Nếu chưa có/không nhớ, gõ "không có".');
      } else {
        await sendMessage(session.data.conversationId, 'Vui lòng chọn 1, 2 hoặc 3.');
      }
      return true;
    }

    case 'patient_not_found': {
      const choice = parseChoice(content, 2);
      if (choice === 1) {
        session.step = 'identifier';
        await sendMessage(session.data.conversationId, 'Anh/chị nhập lại mã y tế hoặc CCCD.');
      } else if (choice === 2) {
        session.step = 'cccd';
        await sendMessage(session.data.conversationId, 'Anh/chị vui lòng nhập CCCD 12 số. Nếu chưa có/không nhớ, gõ "không có".');
      } else {
        await sendMessage(session.data.conversationId, 'Vui lòng chọn 1 hoặc 2.');
      }
      return true;
    }

    case 'cccd': {
      const value = content.trim();
      if (!isSkip(value) && !/^\d{12}$/.test(value)) {
        await sendMessage(session.data.conversationId, 'CCCD cần gồm 12 chữ số. Nếu chưa có/không nhớ, gõ "không có".');
        return true;
      }
      session.data.cccd = isSkip(value) ? '' : value;
      session.step = 'name';
      await sendMessage(session.data.conversationId, 'Anh/chị cho biết họ tên đầy đủ?');
      return true;
    }

    case 'name':
      session.data.tenbenhnhan = content.trim();
      session.step = 'gender';
      await sendMessage(session.data.conversationId, 'Giới tính của anh/chị?\n1. Nam\n2. Nữ');
      return true;

    case 'gender': {
      const value = normalize(content);
      if (value === '1' || value === 'nam') session.data.gioitinh = 'T';
      else if (value === '2' || value === 'nu') session.data.gioitinh = 'G';
      else {
        await sendMessage(session.data.conversationId, 'Vui lòng chọn giới tính:\n1. Nam\n2. Nữ');
        return true;
      }
      session.step = 'birth';
      await sendMessage(session.data.conversationId, 'Anh/chị nhập ngày sinh theo dạng dd/mm/yyyy. Nếu không nhớ ngày, nhập năm sinh, ví dụ 1988.');
      return true;
    }

    case 'birth': {
      const value = content.trim();
      if (/^\d{2}\/\d{2}\/\d{4}$/.test(value)) {
        session.data.ngaysinh = value;
        session.data.namsinh = value.slice(-4);
      } else if (/^\d{4}$/.test(value)) {
        session.data.namsinh = value;
      } else {
        await sendMessage(session.data.conversationId, 'Ngày sinh chưa đúng định dạng. Vui lòng nhập dd/mm/yyyy hoặc năm sinh, ví dụ 1988.');
        return true;
      }
      session.step = 'phone';
      await sendMessage(session.data.conversationId, 'Số điện thoại liên hệ của anh/chị?');
      return true;
    }

    case 'phone': {
      const value = content.trim();
      if (!/^(0|\+84)\d{9,10}$/.test(value)) {
        await sendMessage(session.data.conversationId, 'Số điện thoại chưa hợp lệ. Vui lòng nhập số Việt Nam, ví dụ 0912345678.');
        return true;
      }
      session.data.sodienthoai = value;
      session.step = 'address';
      await sendMessage(session.data.conversationId, 'Anh/chị nhập địa chỉ liên hệ. Nếu muốn bỏ qua, gõ "bỏ qua".');
      return true;
    }

    case 'address':
      session.data.diachi = isSkip(content) ? '' : content.trim();
      await askService(session, sendMessage);
      return true;

    case 'service': {
      const choice = parseChoice(content, session.services.length);
      if (!choice) {
        await sendMessage(session.data.conversationId, 'Vui lòng chọn dịch vụ bằng số thứ tự trong danh sách.');
        return true;
      }
      const service = session.services[choice - 1];
      session.selectedService = service;
      Object.assign(session.data, {
        madichvu: service.madichvu,
        tendichvu: service.tendichvu_his || service.tendichvu_ym,
        loaidichvu: service.loaidichvu,
        doituong: String(service.doituong),
        loaigia: String(service.loaigia),
        gia: service.gia,
      });
      await askDate(session, sendMessage);
      return true;
    }

    case 'date': {
      const choice = parseChoice(content, session.dateOptions.length);
      if (!choice) {
        await sendMessage(session.data.conversationId, 'Vui lòng chọn ngày khám bằng số thứ tự trong danh sách.');
        return true;
      }
      const date = session.dateOptions[choice - 1];
      session.data.ngaykham = date.ngaykham;
      session.data.phongkham = date.phongkham;
      session.step = 'confirm';
      await sendMessage(session.data.conversationId, buildSummary(session));
      return true;
    }

    case 'confirm': {
      const choice = parseChoice(content, 2);
      if (choice === 1) {
        await saveRequest(session, sendMessage);
      } else if (choice === 2) {
        sessions.delete(session.data.conversationId);
        await sendMessage(session.data.conversationId, 'Đã hủy yêu cầu đặt lịch. Khi cần đặt lại, anh/chị gõ "đặt lịch khám".');
      } else {
        await sendMessage(session.data.conversationId, 'Vui lòng trả lời 1 để gửi yêu cầu hoặc 2 để hủy.');
      }
      return true;
    }

    default:
      sessions.delete(session.data.conversationId);
      return false;
  }
}

async function startAppointmentFlow(conversationId, sendMessage) {
  cleanExpiredSessions();
  const session = startSession(conversationId);
  await sendMessage(conversationId, [
    'Bot sẽ hỗ trợ anh/chị tạo yêu cầu đặt lịch khám. Yêu cầu này sẽ được lưu chờ nhân viên duyệt, chưa ghi ngay vào hệ thống bệnh viện.',
    '',
    'Anh/chị thuộc trường hợp nào?',
    '1. Đã từng khám/có mã y tế hoặc CCCD',
    '2. Bệnh nhân mới/chưa có mã y tế',
    '',
    'Trong lúc đặt lịch, anh/chị có thể gõ "hủy" để dừng.'
  ].join('\n'));
}

async function handleAppointmentMessage(conversationId, content, sendMessage) {
  cleanExpiredSessions();
  const session = sessions.get(conversationId);
  if (!session) return false;
  return handleActiveSession(session, content, sendMessage);
}

module.exports = {
  startAppointmentFlow,
  handleAppointmentMessage,
};
