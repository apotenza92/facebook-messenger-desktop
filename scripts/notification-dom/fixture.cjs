// In-page fixture helpers for the notification DOM harness. The returned
// source runs in the page before the app's scripts and exposes
// window.__fx for building and mutating a Messenger-shaped chat list.
//
// The row shape mirrors what the injected observer reads today: a
// [role=navigation] containing a [role=grid] of [role=row] items, each with
// a thread link, [dir=auto] title and preview, an optional relative time
// and an unread marker. Locale strings are parameters so non-English
// layouts can be exercised.

const FIXTURE_SOURCE = String.raw`
(() => {
  const DEFAULT_LOCALE = {
    chatsLabel: "Chats",
    unreadText: "Unread message:",
    markAsReadLabel: "Mark as read",
  };
  let locale = { ...DEFAULT_LOCALE };

  const escapeHtml = (value) =>
    String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");

  // timeStyle "own" puts the relative time in its own [dir=auto] node,
  // which the current freshness parser understands; "inline" renders it
  // as a plain span, as some layouts and locales do.
  const renderRow = (row) => {
    const time = row.time
      ? row.timeStyle === "inline"
        ? '<span class="time">' + escapeHtml(row.time) + "</span>"
        : '<span dir="auto" class="time">' + escapeHtml(row.time) + "</span>"
      : "";
    const unreadText = row.unread
      ? '<span class="sr-only">' + escapeHtml(locale.unreadText) + "</span>"
      : "";
    const unreadButton = row.unread
      ? '<div role="button" aria-label="' +
        escapeHtml(locale.markAsReadLabel) +
        '"></div>'
      : "";
    return (
      '<div role="row" data-fx-href="' + escapeHtml(row.href) + '">' +
      '<a role="link" href="' + escapeHtml(row.href) + '">' +
      '<span dir="auto" class="title">' + escapeHtml(row.title) + "</span>" +
      '<div class="preview">' + unreadText +
      '<span dir="auto" class="body">' + escapeHtml(row.body) + "</span>" +
      (time ? '<span aria-hidden="true"> · </span>' + time : "") +
      "</div></a>" + unreadButton + "</div>"
    );
  };

  const grid = () => document.querySelector('[role="grid"]');
  const rowEl = (href) =>
    document.querySelector('[role="row"][data-fx-href="' + href + '"]');

  window.__fx = {
    setLocale(next) {
      locale = { ...DEFAULT_LOCALE, ...next };
    },
    mountSidebar(rows) {
      const mount = document.getElementById("mount");
      mount.innerHTML =
        '<div role="navigation"><div role="grid" aria-label="' +
        escapeHtml(locale.chatsLabel) + '">' +
        rows.map(renderRow).join("") +
        "</div></div>";
    },
    // Replace a row in place (Messenger re-renders the row node).
    replaceRow(row) {
      const existing = rowEl(row.href);
      const holder = document.createElement("div");
      holder.innerHTML = renderRow(row);
      const next = holder.firstElementChild;
      if (existing) existing.replaceWith(next);
      else grid().prepend(next);
    },
    // Apply a new message the way Messenger's keyed React list does:
    // move the existing row node to the top, then patch its title,
    // preview, time and unread marker in place.
    updateRow(row, options = {}) {
      const existing = rowEl(row.href);
      if (!existing) {
        const holder = document.createElement("div");
        holder.innerHTML = renderRow(row);
        grid().prepend(holder.firstElementChild);
        return;
      }
      if (options.moveToTop !== false && grid().firstElementChild !== existing) {
        grid().prepend(existing);
      }
      const holder = document.createElement("div");
      holder.innerHTML = renderRow(row);
      const fresh = holder.firstElementChild;
      const patchText = (selector) => {
        const from = fresh.querySelector(selector);
        const to = existing.querySelector(selector);
        if (from && to) {
          if (to.textContent !== from.textContent) to.textContent = from.textContent;
        } else if (from && !to) {
          existing.querySelector(".preview").append(from);
        } else if (!from && to) {
          to.remove();
        }
      };
      patchText(".title");
      patchText(".body");
      // The time element's structure depends on its style, so swap it.
      const fromTime = fresh.querySelector(".time");
      const toTime = existing.querySelector(".time");
      if (fromTime && toTime) toTime.replaceWith(fromTime);
      else if (fromTime) existing.querySelector(".preview").append(fromTime);
      else if (toTime) toTime.remove();
      this.setUnread(row.href, Boolean(row.unread));
    },
    setUnread(href, unread) {
      const existing = rowEl(href);
      if (!existing) return;
      const marker = existing.querySelector(".sr-only");
      const button = existing.querySelector('[role="button"]');
      if (unread && !marker) {
        const span = document.createElement("span");
        span.className = "sr-only";
        span.textContent = locale.unreadText;
        existing.querySelector(".preview").prepend(span);
      }
      if (unread && !button) {
        const div = document.createElement("div");
        div.setAttribute("role", "button");
        div.setAttribute("aria-label", locale.markAsReadLabel);
        existing.append(div);
      }
      if (!unread) {
        marker?.remove();
        button?.remove();
      }
    },
    // Update only the preview text node, as React does for small changes.
    setBodyText(href, body) {
      const node = rowEl(href)?.querySelector(".body");
      if (node) node.textContent = body;
    },
    removeRow(href) {
      rowEl(href)?.remove();
    },
    captured: [],
  };

  // Collect diagnostics probe events (only posted when the probe runs).
  window.__fx.probeEvents = [];
  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.data && event.data.type === "electron-notification-probe") {
      window.__fx.probeEvents.push(event.data.data);
    }
  });

  // Stand in for the main-process bridge so every notification the page
  // decides to send is recorded instead of shown.
  window.__mdHarnessCapture = (data) => {
    window.__fx.captured.push({
      title: data.title,
      body: data.body,
      href: data.href,
      sourceKind: data.sourceKind,
      sourceLabel: data.sourceLabel,
    });
  };
})();
`;

module.exports = { FIXTURE_SOURCE };
