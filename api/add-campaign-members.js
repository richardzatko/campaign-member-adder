import jsforce from 'jsforce';
import { appendLog } from './_log-store.js';

// Generic/free email domains to skip
var GENERIC_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com',
  'msn.com', 'yahoo.com', 'yahoo.co.uk', 'ymail.com', 'aol.com',
  'icloud.com', 'me.com', 'mac.com', 'mail.com', 'protonmail.com',
  'proton.me', 'zoho.com', 'gmx.com', 'gmx.net', 'fastmail.com',
  'tutanota.com', 'hey.com', 'pm.me', 'inbox.com', 'email.com',
  'comcast.net', 'verizon.net', 'att.net', 'sbcglobal.net', 'cox.net',
  'charter.net', 'earthlink.net', 'juno.com', 'naver.com', 'qq.com',
  '163.com', '126.com', 'sina.com', 'rediffmail.com', 'yandex.com',
  'yandex.ru', 'web.de', 'libero.it', 'virgilio.it', 'laposte.net',
  'orange.fr', 'wanadoo.fr', 't-online.de', 'seznam.cz', 'wp.pl',
  'o2.pl', 'rambler.ru', 'mail.ru', 'bigpond.com', 'aim.com'
];

// Simple email validation regex
var EMAIL_REGEX = /^[a-zA-Z0-9._%+\-']+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/;

function isGenericDomain(email) {
  var domain = email.split('@')[1];
  return domain ? GENERIC_DOMAINS.indexOf(domain.toLowerCase()) !== -1 : true;
}

function extractEmails(text) {
  // Split by newlines, commas, semicolons, and whitespace to handle any CSV format
  var tokens = text.split(/[\r\n,;\t]+/);
  var emails = [];
  tokens.forEach(function(token) {
    // Strip quotes and whitespace
    var cleaned = token.replace(/["']/g, '').trim().toLowerCase();
    // Only keep valid-looking emails, skip header rows
    if (cleaned && cleaned.includes('@') && !cleaned.startsWith('email') && EMAIL_REGEX.test(cleaned)) {
      emails.push(cleaned);
    }
  });
  return emails;
}

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  res.setHeader('Access-Control-Allow-Origin', '*');

  // Accept both underscore and no-underscore key names from Zapier
  var body = req.body;
  var campaign_id = body.campaign_id || body.campaignid;
  var file_id = body.file_id || body.fileid;
  var rawEmails = body.emails;

  if (!campaign_id || typeof campaign_id !== 'string') {
    return res.status(400).json({ error: 'campaign_id is required' });
  }

  var allExtracted = [];
  var skippedGeneric = [];

  // If file_id is provided, download CSV from Google Drive
  if (file_id) {
    try {
      // Try Google Sheets export URL first (for native Google Sheets)
      var csvUrl = 'https://docs.google.com/spreadsheets/d/' + file_id + '/export?format=csv';
      var csvResp = await fetch(csvUrl);

      // If Sheets export fails, try Google Drive direct download (for uploaded CSV files)
      if (!csvResp.ok) {
        csvUrl = 'https://drive.google.com/uc?export=download&id=' + file_id;
        csvResp = await fetch(csvUrl);
      }

      if (!csvResp.ok) {
        return res.status(200).json({
          error: 'Failed to download file: ' + csvResp.status,
          added: 0, skipped: 0, total_emails: 0
        });
      }

      var csvText = await csvResp.text();
      allExtracted = extractEmails(csvText);
    } catch (err) {
      return res.status(200).json({
        error: 'File download failed: ' + err.message,
        added: 0, skipped: 0, total_emails: 0
      });
    }
  } else if (rawEmails && Array.isArray(rawEmails)) {
    allExtracted = rawEmails.map(function(e) { return e.trim().toLowerCase(); })
      .filter(function(e) { return e && EMAIL_REGEX.test(e); });
  } else if (rawEmails && typeof rawEmails === 'string') {
    allExtracted = extractEmails(rawEmails);
  }

  // Filter out generic domains
  var emails = [];
  allExtracted.forEach(function(email) {
    if (isGenericDomain(email)) {
      skippedGeneric.push(email);
    } else {
      emails.push(email);
    }
  });

  if (emails.length === 0) {
    return res.status(200).json({
      message: 'No valid business emails to process.',
      total_extracted: allExtracted.length,
      skipped_generic: skippedGeneric.length,
      skipped_generic_emails: skippedGeneric,
      added: 0,
      skipped: 0
    });
  }

  try {
    var conn = new jsforce.Connection({
      loginUrl: 'https://login.salesforce.com'
    });

    await conn.login(
      process.env.SF_USERNAME,
      process.env.SF_PASSWORD + process.env.SF_SECURITY_TOKEN
    );

    // Query contacts by email in batches of 200
    var contactMap = {};
    for (var i = 0; i < emails.length; i += 200) {
      var batch = emails.slice(i, i + 200);
      // Escape single quotes in emails for SOQL
      var escapedBatch = batch.map(function(e) { return e.replace(/'/g, "\\'"); });
      var soql = "SELECT Id, Email FROM Contact WHERE Email IN ('" + escapedBatch.join("','") + "')";
      var result = await conn.query(soql);
      result.records.forEach(function(rec) {
        contactMap[rec.Email.toLowerCase()] = rec.Id;
      });
    }

    // Build CampaignMember records - skip emails not found as contacts
    var membersToInsert = [];
    var skippedEmails = [];
    emails.forEach(function(email) {
      var contactId = contactMap[email];
      if (contactId) {
        membersToInsert.push({
          CampaignId: campaign_id,
          ContactId: contactId,
          Status: 'Sent'
        });
      } else {
        skippedEmails.push(email);
      }
    });

    // Insert in batches of 200, allow partial success
    var insertErrors = 0;
    var insertErrorDetails = [];
    for (var m = 0; m < membersToInsert.length; m += 200) {
      var insertBatch = membersToInsert.slice(m, m + 200);
      var insertResult = await conn.sobject('CampaignMember').create(insertBatch, { allOrNone: false });
      for (var n = 0; n < insertResult.length; n++) {
        if (!insertResult[n].success) {
          insertErrors++;
          var errMsg = insertResult[n].errors && insertResult[n].errors.length > 0
            ? insertResult[n].errors[0].message : 'Unknown error';
          insertErrorDetails.push({
            email: emails[m + n] || 'unknown',
            error: errMsg
          });
        }
      }
    }

    var logEntry = {
      timestamp: new Date().toISOString(),
      campaign_id: campaign_id,
      total_extracted: allExtracted.length,
      total_after_filtering: emails.length,
      skipped_generic: skippedGeneric.length,
      skipped_generic_emails: skippedGeneric,
      added: membersToInsert.length - insertErrors,
      skipped_not_found: skippedEmails.length,
      skipped_not_found_emails: skippedEmails,
      insert_errors: insertErrors,
      insert_error_details: insertErrorDetails
    };

    appendLog(logEntry);

    return res.status(200).json(logEntry);

  } catch (err) {
    return res.status(200).json({
      error: err.message,
      added: 0,
      skipped: 0,
      total_emails: emails.length
    });
  }
}
