# Deployment

This app now provides real account registration and login. Passwords are stored as salted hashes, login sessions use HttpOnly cookies, and each account has an isolated product catalog and transaction history. New accounts receive the product catalog and start with an empty transaction sheet.

For a downloadable standalone edition, the local SQLite database is self-contained at `data/jomitch.sqlite`; it starts automatically with the app. The Settings page also exports/restores portable, per-account JSON backups. These backups do not include password hashes or login sessions.

## Vercel

Vercel serves the React build from `dist` and runs the account API in the `api/` functions. The Vercel API uses managed PostgreSQL; it accepts `DATABASE_URL` or `POSTGRES_URL`. Add a Postgres provider from the Vercel Marketplace and make its connection string available as one of those variables in Production and Preview. The API creates its tables and starter product catalog on first request.

1. Push this project to a GitHub repository and import it in Vercel.
2. Connect a PostgreSQL provider from the Vercel Marketplace and expose its connection string as `DATABASE_URL` (or `POSTGRES_URL`).
3. Redeploy. `/api/health` should return `{"ok":true,"database":"postgres"}`.

SQLite is used only by the local preview and Docker deployment. Vercel uses PostgreSQL because serverless instances do not share a permanent local SQLite file.

## Local container preview

```sh
docker build -t jomitch-petshop .
docker run --rm -p 4173:4173 -v jomitch-data:/app/data jomitch-petshop
```

Open `http://127.0.0.1:4173`. For a Docker deployment, put it behind HTTPS, set `NODE_ENV=production`, and mount a persistent volume at `/app/data`. The server listens on the provider's `PORT` and binds to `0.0.0.0` in the container. Back up the persistent database volume regularly.

Password reset email/SMS is not enabled yet because no delivery provider is configured. The Forgot password page explains this to users. Email or phone ownership is not verified during signup.
