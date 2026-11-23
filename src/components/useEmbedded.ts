"use client";

import { useSyncExternalStore } from "react";

// Embed mode: on automatically when the page runs inside an iframe (e.g. a
// Missive sidebar or another app), or forced with ?embed=1. Read through
// useSyncExternalStore so the server render (never embedded) and the first
// client render agree, then it switches once the browser is known.
function detectEmbedded(): boolean {
  try {
    if (new URLSearchParams(window.location.search).has("embed")) return true;
    return window.self !== window.top;
  } catch {
    return true; // cross-origin access to window.top throws only when framed
  }
}

const noopSubscribe = () => () => {};

export function useEmbedded(): boolean {
  return useSyncExternalStore(noopSubscribe, detectEmbedded, () => false);
}
