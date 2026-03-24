# Campaign Member Adder

A Vercel serverless app that adds contacts to Salesforce campaigns from a list of email addresses.

## API

### POST /api/add-campaign-members

Accepts a JSON body:
```json
{
  "emails": ["email1@example.com", "email2@example.com"],
  "campaign_id": "7015e000000XXXXX"
}
```

Returns:
```json
{
  "timestamp": "2026-03-24T...",
  "campaign_id": "7015e000000XXXXX",
  "total_emails": 10,
  "added": 8,
  "skipped": 2,
  "skipped_emails": ["notfound1@example.com", "notfound2@example.com"],
  "insert_errors": 0,
  "insert_error_details": []
}
```

### GET /api/campaign-members-log

Returns all run logs.

## Pages

- `/` - Home page
- `/campaign-members-log.html` - Run log viewer

## Environment Variables

| Variable | Description |
|----------|-------------|
| `SF_LOGIN_URL` | Salesforce login URL |
| `SF_USERNAME` | Salesforce username |
| `SF_PASSWORD` | Salesforce password |
| `SF_SECURITY_TOKEN` | Salesforce security token |

## Setup

1. Deploy to Vercel
2. Add the environment variables above
3. Configure the Zapier Zap to call the endpoint after the delay step
