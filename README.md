# Cattle Records API

Cloudflare Worker for Cattle Records.

Keep the Neon connection string in Cloudflare as a secret named `DATABASE_URL`.
Do not add the connection string to this repository.

Current test endpoints:
- `/`
- `/health`

Both test the Neon connection and return the farm record.

For Cloudflare Git integration, use:
- Deploy command: `npx wrangler deploy`
API deployment enabled. 
