// smsmobileapi.js
const fetch = require('node-fetch');

const SMSMOBILEAPI_SEND_ENDPOINT = process.env.SMSMOBILEAPI_SEND_ENDPOINT || 'https://api.smsmobileapi.com/sendsms/';
const SMSMOBILEAPI_SEND_FALLBACK_ENDPOINT = process.env.SMSMOBILEAPI_SEND_FALLBACK_ENDPOINT || 'https://smsmobileapi.com/api/v3/sms/send';
const SMSMOBILEAPI_INBOX_ENDPOINT = process.env.SMSMOBILEAPI_INBOX_ENDPOINT || 'https://api.smsmobileapi.com/getsms/';

function toUnixTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const numeric = Math.floor(value);
    // Auto-normalize milliseconds to seconds.
    return numeric > 9999999999 ? Math.floor(numeric / 1000) : numeric;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) {
      return null;
    }

    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) {
      const asInt = Math.floor(numeric);
      return asInt > 9999999999 ? Math.floor(asInt / 1000) : asInt;
    }

    const parsedDate = new Date(trimmed);
    if (!Number.isNaN(parsedDate.getTime())) {
      return Math.floor(parsedDate.getTime() / 1000);
    }
  }

  return null;
}

function extractInboxRowUnix(row) {
  if (!row || typeof row !== 'object') {
    return null;
  }

  const candidates = [
    row.timestamp_unix,
    row.unix,
    row.timestampUnix,
    row.received_unix,
    row.receivedAt,
    row.timestamp,
    row.date,
  ];

  for (const value of candidates) {
    const parsed = toUnixTimestamp(value);
    if (parsed) {
      return parsed;
    }
  }

  return null;
}

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

async function fetchSmsMobileInbox({ apiKey, limit = 50, afterTimestampUnix = null }) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, Number(limit))) : 50;
  const query = new URLSearchParams({
    apikey: apiKey,
  });

  if (typeof afterTimestampUnix === 'number' && Number.isFinite(afterTimestampUnix) && afterTimestampUnix > 0) {
    const afterUnix = String(Math.floor(afterTimestampUnix));
    // Include common parameter aliases for compatibility across API variants.
    query.set('after_timestamp_unix', afterUnix);
    query.set('after_unix', afterUnix);
    query.set('after', afterUnix);
  }
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

  const smsRows = Array.isArray(getBody.result.sms) ? [...getBody.result.sms] : [];
  smsRows.sort((left, right) => {
    const leftUnix = extractInboxRowUnix(left) || 0;
    const rightUnix = extractInboxRowUnix(right) || 0;
    return rightUnix - leftUnix;
  });

  if (safeLimit < smsRows.length) {
    return {
      ...getBody,
      result: {
        ...getBody.result,
        sms: smsRows.slice(0, safeLimit),
      },
    };
  }

  getBody.result.sms = smsRows;

  return getBody;
}

module.exports = { sendSmsMobileApi, fetchSmsMobileInbox };
