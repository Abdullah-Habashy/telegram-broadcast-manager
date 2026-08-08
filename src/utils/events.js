// مدير Server-Sent Events (SSE) لإرسال الإشعارات الفورية للمتصفح
const clients = new Set();

function registerClient(req, res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // لمنع التخزين المؤقت من الـ Proxy / Nginx / Tunnel
  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  // إرسال تأكيد الاتصال
  res.write('data: {"type":"connected"}\n\n');

  clients.add(res);
  console.log(`📡 SSE client connected. Active connections: ${clients.size}`);

  const heartbeat = setInterval(() => {
    try {
      res.write(': heartbeat\n\n');
    } catch (_) {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clients.delete(res);
    console.log(`📡 SSE client disconnected. Active connections: ${clients.size}`);
  });
}

function notifyNewIncomingMessage(data) {
  const payload = JSON.stringify({
    type: 'new_incoming_message',
    ...data,
  });

  console.log(`📢 Broadcasting new message to ${clients.size} SSE client(s)...`, data);

  clients.forEach((res) => {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.error('❌ Failed to write SSE payload to client:', err.message);
      clients.delete(res);
    }
  });
}

module.exports = {
  registerClient,
  notifyNewIncomingMessage,
};
