import jsforce from 'jsforce';
import { appendLog } from './_log-store.js';

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
  const body = req.body;
    const campaign_id = body.campaign_id || body.campaignid;
    const file_id = body.file_id || body.fileid;
    const rawEmails = body.emails;

  if (!campaign_id || typeof campaign_id !== 'string') {
        return res.status(400).json({ error: 'campaign_id is required' });
  }

  let emails = [];

  // If file_id is provided, download CSV from Google Sheets
  if (file_id) {
        try {
                const csvUrl = 'https://docs.google.com/spreadsheets/d/' + file_id + '/export?format=csv';
                const csvResp = await fetch(csvUrl);
                if (!csvResp.ok) {
                          return res.status(400).json({ error: 'Failed to download file: ' + csvResp.status });
                }
                const csvText = await csvResp.text();
                // Parse CSV: split by newlines, trim, filter valid emails
          emails = csvText.split(/\r?\n/)
                  .map(function(line) { return line.replace(/"/g, '').trim().toLowerCase(); })
                  .filter(function(line) { return line && line.includes('@') && !line.startsWith('email'); });
        } catch (err) {
                return res.status(500).json({ error: 'File download failed: ' + err.message });
        }
  } else if (rawEmails && Array.isArray(rawEmails)) {
        emails = rawEmails
          .map(function(e) { return (typeof e === 'string' ? e : '').trim().toLowerCase(); })
          .filter(function(e) { return e && e.includes('@'); });
  } else {
        return res.status(400).json({ error: 'Either emails array or file_id is required' });
  }

  // Deduplicate
  emails = Array.from(new Set(emails));

  if (emails.length === 0) {
        return res.status(400).json({ error: 'No valid emails found' });
  }

  try {
        // Connect to Salesforce
      var conn = new jsforce.Connection({
              loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com'
      });
        await conn.login(
                process.env.SF_USERNAME,
                process.env.SF_PASSWORD + (process.env.SF_SECURITY_TOKEN || '')
              );

      // Query contacts in batches of 200
      var contactMap = {};
        for (var i = 0; i < emails.length; i += 200) {
                var batch = emails.slice(i, i + 200);
                var soql = "SELECT Id, Email FROM Contact WHERE Email IN ('" + batch.join("','") + "')";
                var result = await conn.query(soql);
                if (result.records) {
                          for (var j = 0; j < result.records.length; j++) {
                                      var rec = result.records[j];
                                      var emailLower = rec.Email.toLowerCase();
                                      if (!contactMap[emailLower]) {
                                                    contactMap[emailLower] = rec.Id;
                                      }
                          }
                }
        }

      // Build CampaignMember records
      var membersToInsert = [];
        var skippedEmails = [];
        for (var k = 0; k < emails.length; k++) {
                var em = emails[k];
                if (contactMap[em]) {
                          membersToInsert.push({
                                      CampaignId: campaign_id,
                                      ContactId: contactMap[em],
                                      Status: 'Sent'
                          });
                } else {
                          skippedEmails.push(em);
                }
        }

      // Bulk insert in batches of 200
      var insertErrors = 0;
        var insertErrorDetails = [];
        for (var m = 0; m < membersToInsert.length; m += 200) {
                var insertBatch = membersToInsert.slice(m, m + 200);
                var insertResult = await conn.sobject('CampaignMember').create(insertBatch);
                if (!Array.isArray(insertResult)) insertResult = [insertResult];
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
              total_emails: emails.length,
              added: membersToInsert.length - insertErrors,
              skipped: skippedEmails.length,
              skipped_emails: skippedEmails,
              insert_errors: insertErrors,
              insert_error_details: insertErrorDetails
      };

      appendLog(logEntry);

      return res.status(200).json(logEntry);
  } catch (err) {
        return res.status(500).json({ error: err.message });
  }
}
