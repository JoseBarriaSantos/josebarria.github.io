"use strict";

const lichessAuth = (() => {
  const CLIENT_ID = "novelty-hunter";
  const TOKEN_KEY = "nh_lichess_token";

  const _uri = () => window.location.origin + window.location.pathname;

  async function _verifier() {
    const arr = new Uint8Array(32);
    crypto.getRandomValues(arr);
    return btoa(String.fromCharCode(...arr))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  async function _challenge(v) {
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v));
    return btoa(String.fromCharCode(...new Uint8Array(hash)))
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  }

  async function startLogin() {
    const v = await _verifier();
    sessionStorage.setItem("nh_pkce", v);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: _uri(),
      code_challenge: await _challenge(v),
      code_challenge_method: "S256",
    });
    window.location.href = "https://lichess.org/oauth?" + params;
  }

  async function handleCallback() {
    const code = new URLSearchParams(window.location.search).get("code");
    if (!code) return null;
    history.replaceState({}, "", window.location.pathname);
    const v = sessionStorage.getItem("nh_pkce");
    sessionStorage.removeItem("nh_pkce");
    if (!v) return null;
    try {
      const r = await fetch("https://lichess.org/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: _uri(),
          client_id: CLIENT_ID,
          code_verifier: v,
        }),
      });
      if (!r.ok) return null;
      return (await r.json()).access_token || null;
    } catch { return null; }
  }

  async function getUsername(token) {
    try {
      const r = await fetch("https://lichess.org/api/account", {
        headers: { Authorization: "Bearer " + token },
      });
      if (!r.ok) return null;
      return (await r.json()).username || null;
    } catch { return null; }
  }

  const getToken  = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
  const saveToken = (t) => { try { localStorage.setItem(TOKEN_KEY, t); } catch {} };
  const clearToken = () => { try { localStorage.removeItem(TOKEN_KEY); } catch {} };

  return { startLogin, handleCallback, getUsername, getToken, saveToken, clearToken };
})();
