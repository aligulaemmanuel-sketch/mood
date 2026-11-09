"use strict";

const CACHE_NAME = "beacon-kenya-shell-v8";
const APP_SHELL = [
  "/",
  "/static/styles.css",
  "/static/app.js",
  "/static/first-aid-scene.svg",
  "/static/aid-allergy.svg",
  "/static/aid-bleeding.svg",
  "/static/aid-burn.svg",
  "/static/aid-choking.svg",
  "/static/aid-cpr.svg",
  "/static/aid-fracture.svg",
  "/static/aid-fire.svg",
  "/static/aid-handover.svg",
  "/static/aid-shock.svg",
  "/static/aid-snakebite.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(APP_SHELL);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(
      names.filter((name) => name.startsWith("beacon-kenya-shell-") && name !== CACHE_NAME)
        .map((name) => caches.delete(name)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== "GET") return;
  if (
    url.origin === "https://unpkg.com"
    && url.pathname.startsWith("/leaflet@1.9.4/dist/")
  ) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE_NAME);
      const cachedAsset = await cache.match(request);
      if (cachedAsset) return cachedAsset;
      try {
        const response = await fetch(request);
        if (response.ok) await cache.put(request, response.clone());
        return response;
      } catch {
        return new Response("", { status: 503, statusText: "Offline" });
      }
    })());
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(request);
        if (response.ok) {
          const cache = await caches.open(CACHE_NAME);
          await cache.put("/", response.clone());
        }
        return response;
      } catch {
        const cachedPage = await caches.match("/");
        if (cachedPage) return cachedPage;
        return new Response("Offline. Reconnect and reload the app.", {
          status: 503,
          headers: { "Content-Type": "text/plain; charset=utf-8" },
        });
      }
    })());
    return;
  }

  if (url.pathname.startsWith("/static/")) {
    event.respondWith((async () => {
      const cachedAsset = await caches.match(request);
      if (cachedAsset) return cachedAsset;
      return fetch(request);
    })());
  }
});
