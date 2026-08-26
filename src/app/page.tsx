export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>🚀 API Rate Limiter</h1>
      <p>Test endpoints:</p>
      <ul>
        <li>
          <code>GET /api/ping</code> (10/min)
        </li>
        <li>
          <code>POST /api/echo</code> (5/min)
        </li>
        <li>
          <code>POST /api/contact</code> (3/10min)
        </li>
      </ul>
      <p>Try making requests to hit the rate limit and see 429 responses.</p>
      <hr />
      <h2>Quick Test</h2>
      <pre>
{`# Test ping endpoint (10/min)
for i in {1..11}; do echo "Request $i:" && curl -i http://localhost:3000/api/ping; done

# Test contact endpoint
curl -X POST http://localhost:3000/api/contact \\
  -H "Content-Type: application/json" \\
  -d '{"name":"John","email":"john@example.com","message":"Hello from the API limiter!"}'`}
      </pre>
    </main>
  );
}