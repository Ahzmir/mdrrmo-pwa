// smsmobileapi.js
const fetch = require('node-fetch');

const SMSMOBILEAPI_ENDPOINT = 'https://smsmobileapi.com/api/v3/sms/send';
const SMSMOBILEAPI_INBOX_ENDPOINT = process.env.SMSMOBILEAPI_INBOX_ENDPOINT || 'https://smsmobileapi.com/api/v3/sms/inbox';

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

async function fetchSmsMobileInbox({ apiKey, limit = 50 }) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Number(limit))) : 50;

  const postResponse = await fetch(SMSMOBILEAPI_INBOX_ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      limit: safeLimit,
    }),
  });

  let postBody = null;
  try {
    postBody = await postResponse.json();
  } catch {
    postBody = null;
  }

  if (postResponse.ok) {
    return postBody;
  }

  // Some providers expose inbox via GET with API key in query params.
  const query = new URLSearchParams({
    api_key: apiKey,
    limit: String(safeLimit),
  });
  const getResponse = await fetch(`${SMSMOBILEAPI_INBOX_ENDPOINT}?${query.toString()}`, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
    },
  });

  let getBody = null;
  try {
    getBody = await getResponse.json();
  } catch {
    getBody = null;
  }

  if (!getResponse.ok) {
    throw new Error(
      `SMSMobileAPI inbox request failed. POST status ${postResponse.status}, GET status ${getResponse.status}`
    );
  }

  return getBody;
}

module.exports = { sendSmsMobileApi, fetchSmsMobileInbox };
