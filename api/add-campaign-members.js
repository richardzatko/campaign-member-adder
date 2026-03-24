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

  const { emails, campaign_id } = req.body;

  if (!campaign_id || typeof campaign_id !== 'string') {
    return res.status(400).json({ error: 'campaign_id is required' });
  }

  if (!emails || !Array.isArray(emails) || emails.length === 0) {
    return res.status(400).json({ error: 'emails array is required and must not be empty' });
  }

  // Normalize and deduplicate input emails
  const cleanEmails = [...new Set(
    emails
      .map(e => (e || '').trim().toLowerCase())
      .filter(e => e.length > 0 && e.includes('@'))
  )];

  if (cleanEmails.length === 0) {
    return res.status(400).json({ error: 'No valid email addresses found' });
  }

  // Connect to Salesforce
  const conn = new jsforce.Connection({
    loginUrl: process.env.SF_LOGIN_URL || 'https://login.salesforce.com'
  });

  try {
    await conn.login(
      process.env.SF_USERNAME,
      process.env.SF_PASSWORD + (process.env.SF_SECURITY_TOKEN || '')
    );
  } catch (err) {
    console.error('SFDC login failed:', err.message);
    return res.status(500).json({ error: 'Salesforce authentication failed' });
  }

  try {
    // Query Contacts in batches of 200
    const contactMap = {}; // email -> first Contact Id
    for (let i = 0; i < cleanEmails.length; i += 200) {
      const batch = cleanEmails.slice(i, i + 200);
      const emailList = batch.map(e => "'" + e.replace(/'/g, "\\'") + "'").join(',');
      const soql = 'SELECT Id, Email FROM Contact WHERE Email IN (' + emailList + ')';

      const result = await conn.query(soql);
      for (const record of result.records) {
        const normalizedEmail = record.Email.toLowerCase();
        // Only keep the first Contact per email (handle duplicates)
        if (!contactMap[normalizedEmail]) {
          contactMap[normalizedEmail] = record.Id;
        }
      }
    }

    // Determine which emails were found vs skipped
    const foundEmails = [];
    const skippedEmails = [];

    for (const email of cleanEmails) {
      if (contactMap[email]) {
        foundEmails.push({ email, contactId: contactMap[email] });
      } else {
        skippedEmails.push(email);
      }
    }

    // Bulk insert CampaignMembers for found contacts
    let addedCount = 0;
    let insertErrors = [];

    if (foundEmails.length > 0) {
      const campaignMembers = foundEmails.map(({ contactId }) => ({
        CampaignId: campaign_id,
        ContactId: contactId,
        Status: 'Sent'
      }));

      // Insert in batches of 200
      for (let i = 0; i < campaignMembers.length; i += 200) {
        const batch = campaignMembers.slice(i, i + 200);
        const results = await conn.sobject('CampaignMember').create(batch);

        for (let j = 0; j < results.length; j++) {
          if (results[j].success) {
            addedCount++;
          } else {
            const email = foundEmails[i + j].email;
            const errMsg = results[j].errors.map(e => e.message).join('; ');
            insertErrors.push({ email, error: errMsg });
            console.error('Failed to add ' + email + ': ' + errMsg);
          }
        }
      }
    }

    // Build response
    const logEntry = {
      timestamp: new Date().toISOString(),
      campaign_id,
      total_emails: cleanEmails.length,
      added: addedCount,
      skipped: skippedEmails.length,
      skipped_emails: skippedEmails,
      insert_errors: insertErrors.length,
      insert_error_details: insertErrors
    };

    // Store log
    try {
      appendLog(logEntry);
    } catch (logErr) {
      console.error('Failed to store log:', logErr.message);
    }

    return res.status(200).json(logEntry);
  } catch (err) {
    console.error('Error processing campaign members:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
