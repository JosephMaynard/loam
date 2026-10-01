import posthog from "posthog-js";

// Progressive enhancement only: the page is fully readable without any of this.

// Current year in the footer.
const yearEl = document.getElementById("year");
if (yearEl) {
  yearEl.textContent = String(new Date().getFullYear());
}

// A hairline under the header once the page has scrolled.
const header = document.querySelector(".site-header");
if (header) {
  const update = () => header.classList.toggle("scrolled", window.scrollY > 8);
  update();
  window.addEventListener("scroll", update, { passive: true });
}

// Mobile nav toggle.
const toggle = document.querySelector(".nav-toggle");
const links = document.getElementById("nav-links");
if (toggle && links) {
  toggle.addEventListener("click", () => {
    const open = links.classList.toggle("open");
    toggle.setAttribute("aria-expanded", String(open));
  });
  // Close the menu after tapping a link (or anything inside one).
  links.addEventListener("click", (event) => {
    const link = event.target instanceof Element ? event.target.closest("a") : null;
    if (link) {
      links.classList.remove("open");
      toggle.setAttribute("aria-expanded", "false");
    }
  });
}

// Copy buttons (`data-copy`): the command goes on the clipboard and the label says so for a moment.
for (const button of document.querySelectorAll("[data-copy]")) {
  const label = button.querySelector(".copy-label");
  button.addEventListener("click", async () => {
    const text = button.getAttribute("data-copy") ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return; // No clipboard (an old browser, or permission refused): the command is on screen to type.
    }
    button.classList.add("copied");
    if (label) {
      label.textContent = "Copied";
    }
    window.setTimeout(() => {
      button.classList.remove("copied");
      if (label) {
        label.textContent = "Copy";
      }
    }, 1800);
  });
}

// Reveal-on-scroll. Skipped entirely when the user prefers reduced motion (the content is visible
// without it).
const prefersReducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const revealables = document.querySelectorAll(".reveal");

if (!prefersReducedMotion && "IntersectionObserver" in window) {
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
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 },
  );
  revealables.forEach((el) => observer.observe(el));
}

// Privacy-friendly interest analytics (marketing site ONLY, never the app). Cookieless and consent-free by
// construction: `persistence: 'memory'` stores nothing on the device (no cookies, no localStorage), and
// `person_profiles: 'identified_only'` means no profile is ever created since we never identify anyone. We
// disable session recording, surveys and autocapture, so nothing external is loaded (keeps `script-src
// 'self'`): the only network egress is event POSTs to the EU ingest host in `connect-src`. PostHog still
// sees the IP address of each request (see /privacy). The key comes from the Vercel build env; with no
// key set (local dev), this is a no-op.
const posthogKey = import.meta.env.VITE_POSTHOG_KEY;
// EU ingest host, hardcoded to stay in lockstep with the CSP `connect-src` allowlist (vercel.json).
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

  // The interest signals beyond a pageview: a download or GitHub click, and copying the npx command.
  // Resolve the real hostname (not a substring match) so a link such as `https://evil.example/github.com`
  // can't mis-fire an event (CodeQL: incomplete URL sanitization).
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("[data-copy]")) {
      posthog.capture("copy_npx_command");
      return;
    }
    const link = target?.closest("a");
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
