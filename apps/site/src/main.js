import posthog from "posthog-js";

// Progressive enhancement only: the page is fully readable without any of this.

// Current year in the footer.
const yearEl = document.getElementById("year");
if (yearEl) {
  yearEl.textContent = String(new Date().getFullYear());
}

// Mobile nav toggle.
const toggle = document.querySelector(".nav-toggle");
const links = document.getElementById("nav-links");
if (toggle && links) {
  toggle.addEventListener("click", () => {
    const open = links.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  // Close the menu after tapping a link (or anything inside one, e.g. the button label).
  links.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (link) {
      links.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
}

// Reveal-on-scroll. Skipped entirely when the user prefers reduced motion (CSS already shows the
// content in that case).
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealables = document.querySelectorAll(".reveal");

if (prefersReducedMotion || !("IntersectionObserver" in window)) {
  revealables.forEach((el) => el.classList.add("in"));
} else {
  // JS is handling reveals now, so disarm the CSS fail-safe so items stay hidden until scrolled into view.
  document.documentElement.classList.add("reveal-js");
  const observer = new IntersectionObserver(
    (entries, obs) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          entry.target.classList.add("in");
          obs.unobserve(entry.target);
        }
      }
    },
    { rootMargin: "0px 0px -10% 0px", threshold: 0.1 },
  );
  revealables.forEach((el) => observer.observe(el));
}

// Privacy-friendly interest analytics (marketing site ONLY — never the app). Cookieless and
// consent-free by construction: `persistence: 'memory'` stores nothing on the device (no cookies, no
// localStorage), and `person_profiles: 'identified_only'` means no profile is ever created since we
// never identify anyone. We disable session recording / surveys / autocapture, so nothing external is
// loaded (keeps `script-src 'self'`) — the only network egress is anonymous event POSTs to the EU
// ingest host in `connect-src`. The key comes from the Vercel build env; with no key set (local dev),
// this is a no-op. All we measure is "did anyone visit / want to download LOAM", not who.
const posthogKey = import.meta.env.VITE_POSTHOG_KEY;
// EU ingest host, hardcoded to stay in lockstep with the CSP `connect-src` allowlist (vercel.json). A
// different region would be silently blocked by CSP, so it is deliberately NOT an env override — change
// the host here and in the CSP together if the project ever moves region.
const posthogHost = "https://eu.i.posthog.com";
if (posthogKey) {
  posthog.init(posthogKey, {
    api_host: posthogHost,
    persistence: "memory",
    person_profiles: "identified_only",
    autocapture: false,
    capture_pageview: true,
    capture_pageleave: false,
    disable_session_recording: true,
    disable_surveys: true,
    advanced_disable_decide: true,
  });

  // The only interest signals we care about beyond a pageview: someone clicked "Download for Android" or
  // headed to the source on GitHub. Resolve the real hostname (not a substring match) so a link such as
  // `https://evil.example/github.com` can't mis-fire an event (CodeQL: incomplete URL sanitization).
  document.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (!link) {
      return;
    }
    let url;
    try {
      url = new URL(link.href, window.location.href);
    } catch {
      return;
    }
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && !host.endsWith(".github.com")) {
      return;
    }
    posthog.capture(url.pathname.includes("/releases/latest/download") ? "download_apk_click" : "github_click");
  });
}
