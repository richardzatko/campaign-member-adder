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
          emails = rawEmails.map(function(e) { return e.trim().toLowerCase(); });
  } else if (rawEmails && typeof rawEmails === 'string') {
          emails = rawEmails.split(',').map(function(e) { return e.trim().toLowerCase(); });
  }

  if (emails.length === 0) {
          return res.status(400).json({ error: 'No emails provided. Supply file_id or emails.' });
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
                    var soql = "SELECT Id, Email FROM Contact WHERE Email IN ('" + batch.join("','") + "')";
                    var result = await conn.query(soql);
                    result.records.forEach(function(rec) {
                                contactMap[rec.Email.toLowerCase()] = rec.Id;
                    });
          }

        // Build CampaignMember records
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
