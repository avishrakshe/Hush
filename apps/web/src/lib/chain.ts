export const EXPLORER = "https://testnet.snowtrace.io";
export const addressUrl = (a: string) => `${EXPLORER}/address/${a}`;
export const txUrl = (h: string) => `${EXPLORER}/tx/${h}`;
export const shortHex = (h: string, head = 6, tail = 4) => (h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h);

export const REPO_URL = "https://github.com/avishrakshe/Hush";
