import { createApp } from "./app.ts";

const envUrl = process.env.MAKEFUN_ENV_URL;
const shopToken = process.env.MAKEFUN_SHOP_TOKEN;

if (!envUrl) {
  console.error("MAKEFUN_ENV_URL is not set");
  process.exit(1);
}

const app = createApp(shopToken);
const server = app.listen(0, "127.0.0.1", async () => {
  const port = (server.address() as { port: number }).port;
  try {
    await fetch(`${envUrl}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ port }),
    });
  } catch (err) {
    console.error("register failed:", err);
    process.exit(1);
  }

  // Poll until the environment is done, then exit cleanly.
  for (;;) {
    try {
      const res = await fetch(`${envUrl}/done`);
      const data = (await res.json()) as { done?: boolean };
      if (data.done) {
        process.exit(0);
      }
    } catch {
      // Ignore transient errors; keep polling.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
});
