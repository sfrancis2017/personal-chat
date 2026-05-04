# personal-chat

Personal RAG chat at chat.sajivfrancis.com. Static frontend (GitHub Pages) + Cloudflare Worker + pgvector on Digital Ocean.

```bash
# Worker
cd worker && npm i && npm run dev

# Frontend
cd public && python3 -m http.server 8000
```

## Ingest API

```bash
curl -s -w "\nHTTP %{http_code}\n" -X POST -H "Authorization: Bearer $RETRIEVE_TOKEN" -H "Content-Type: application/json" -d '{}' http://localhost:8081/ingest
```
