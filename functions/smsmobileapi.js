// smsmobileapi.js
const fetch = require('node-fetch');

const SMSMOBILEAPI_SEND_ENDPOINT = process.env.SMSMOBILEAPI_SEND_ENDPOINT || 'https://api.smsmobileapi.com/sendsms/';
const SMSMOBILEAPI_SEND_FALLBACK_ENDPOINT = process.env.SMSMOBILEAPI_SEND_FALLBACK_ENDPOINT || 'https://smsmobileapi.com/api/v3/sms/send';
const SMSMOBILEAPI_INBOX_ENDPOINT = process.env.SMSMOBILEAPI_INBOX_ENDPOINT || 'https://api.smsmobileapi.com/getsms/';

function isSendSuccess(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') {
    return false;
  }

  if (responseBody.success === true) {
    return true;
  }

  const result = responseBody.result;
  if (!result || typeof result !== 'object') {
    return false;
  }

  const errorValue = result.error;
  const sentValue = result.sent;
  const noError = errorValue === 0 || errorValue === '0' || errorValue === '' || errorValue === null;
  const sent = sentValue === 1 || sentValue === '1' || sentValue === true;
  return noError && sent;
}

async function sendSmsMobileApi({ apiKey, destination, message }) {
  const formPayload = new URLSearchParams();
  formPayload.set('apikey', apiKey);
  formPayload.set('recipients', destination);
  formPayload.set('message', message);

  const response = await fetch(SMSMOBILEAPI_SEND_ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: formPayload.toString(),
  });

  let responseBody = null;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }

  if (response.ok && isSendSuccess(responseBody)) {
    return responseBody;
  }

  // Fallback for older endpoint variants.
  const fallbackResponse = await fetch(SMSMOBILEAPI_SEND_FALLBACK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      api_key: apiKey,
      recipient: destination,
      message,
    }),
  });

  let fallbackBody = null;
  try {
    fallbackBody = await fallbackResponse.json();
  } catch {
    fallbackBody = null;
  }

  if (fallbackResponse.ok && isSendSuccess(fallbackBody)) {
    return fallbackBody;
  }

  throw new Error(
    `SMSMobileAPI send failed. Primary status ${response.status}, fallback status ${fallbackResponse.status}`
  );
}

async function fetchSmsMobileInbox({ apiKey, limit = 50 }) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Number(limit))) : 50;
  const query = new URLSearchParams({
    apikey: apiKey,
    onlyunread: 'yes',
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
      `SMSMobileAPI inbox request failed with status ${getResponse.status}`
    );
  }

  if (!getBody || typeof getBody !== 'object' || !getBody.result || !Array.isArray(getBody.result.sms)) {
    throw new Error('SMSMobileAPI inbox response format is invalid (expected result.sms array).');
  }

  if (safeLimit < getBody.result.sms.length) {
    return {
      ...getBody,
      result: {
        ...getBody.result,
        sms: getBody.result.sms.slice(0, safeLimit),
      },
    };
  }

  return getBody;
}

module.exports = { sendSmsMobileApi, fetchSmsMobileInbox };
