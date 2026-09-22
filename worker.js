const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });
    const url = new URL(request.url);
    if (url.pathname !== '/api/send-reminder' || request.method !== 'POST') return json({ error: 'Not found' }, 404);

    try {
      const body = await request.json();
      if (!body.phone || !body.title || !body.date || !body.time) return json({ error: 'phone, title, date und time sind erforderlich' }, 400);
      if (!env.WHATSAPP_TOKEN || !env.PHONE_NUMBER_ID) return json({ error: 'WhatsApp-Secrets fehlen noch im Worker' }, 503);

      const response = await fetch(`https://graph.facebook.com/v23.0/${env.PHONE_NUMBER_ID}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: body.phone.replace(/[^0-9]/g, ''),
          type: 'template',
          template: { name: env.WHATSAPP_TEMPLATE || 'appointment_reminder', language: { code: 'de' }, components: [{ type: 'body', parameters: [{ type: 'text', text: body.title }, { type: 'text', text: `${body.date} um ${body.time} Uhr` }] }] }
        })
      });
      const result = await response.json();
      return json(result, response.status);
    } catch (error) { return json({ error: error.message }, 500); }
  }
};

function json(data, status = 200) { return new Response(JSON.stringify(data), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }); }
