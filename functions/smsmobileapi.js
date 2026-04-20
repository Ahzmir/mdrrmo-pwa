// smsmobileapi.js
const fetch = require('node-fetch');

const SMSMOBILEAPI_ENDPOINT = 'https://smsmobileapi.com/api/v3/sms/send';

async function sendSmsMobileApi({ apiKey, destination, message }) {
  const payload = {
    api_key: apiKey,
    recipient: destination,
    message,
  };

  const response = await fetch(SMSMOBILEAPI_ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (!response.ok) {
    throw new Error(
      `SMSMobileAPI request failed with status ${response.status}: ${JSON.stringify(responseBody)}`
    );
  }

  // Adjust this check based on actual API response
  if (!responseBody || !responseBody.success) {
    throw new Error('SMSMobileAPI response did not indicate success.');
  }

  return responseBody;
}

module.exports = { sendSmsMobileApi };
