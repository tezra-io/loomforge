export interface LoomHttpClientOptions {
  baseUrl: string;
  fetch?: typeof fetch;
}

export async function requestJson(
  options: LoomHttpClientOptions,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<unknown> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(new URL(path, options.baseUrl), {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const json = text ? (JSON.parse(text) as unknown) : null;

  if (!response.ok) {
    throw new Error(JSON.stringify(json));
  }

  return json;
}
