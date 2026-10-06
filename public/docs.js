// Progressive enhancements: copy buttons, active TOC highlighting, mobile nav, search.
(function () {
  // Copy buttons.
  document.querySelectorAll(".code .copy").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var code = btn.parentElement.querySelector("code");
      var text = code ? code.innerText : "";
      var done = function () {
        btn.textContent = "Copied";
        btn.classList.add("done");
        setTimeout(function () { btn.textContent = "Copy"; btn.classList.remove("done"); }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      } else {
        var ta = document.createElement("textarea");
        ta.value = text; document.body.appendChild(ta); ta.select();
        try { document.execCommand("copy"); done(); } catch (e) {}
        document.body.removeChild(ta);
      }
    });
  });

  // Mobile nav.
  var menu = document.querySelector(".menu");
  if (menu) {
    menu.addEventListener("click", function () {
      var open = document.body.classList.toggle("nav-open");
      menu.setAttribute("aria-expanded", String(open));
    });
    document.addEventListener("click", function (e) {
      if (!document.body.classList.contains("nav-open")) return;
      if (e.target.closest(".sidebar") || e.target.closest(".menu")) return;
      document.body.classList.remove("nav-open");
      menu.setAttribute("aria-expanded", "false");
    });
  }

  // Keep the current sidebar entry in view.
  var sidebar = document.getElementById("sidebar");
  var current = sidebar && sidebar.querySelector('a[aria-current="page"]');
  if (sidebar && current && sidebar.scrollHeight > sidebar.clientHeight) {
    sidebar.scrollTop = current.offsetTop - sidebar.clientHeight / 2 + current.offsetHeight / 2;
  }

  // Active TOC entry.
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".toc a"));
  if (tocLinks.length && "IntersectionObserver" in window) {
    var byId = {};
    tocLinks.forEach(function (a) { byId[a.getAttribute("href").slice(1)] = a; });
    var headings = Object.keys(byId).map(function (id) { return document.getElementById(id); }).filter(Boolean);
    var active = null;
    var setActive = function (id) {
      if (active) active.classList.remove("active");
      active = byId[id]; if (active) active.classList.add("active");
    };
    var visible = new Set();
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { en.isIntersecting ? visible.add(en.target.id) : visible.delete(en.target.id); });
      for (var i = 0; i < headings.length; i++) { if (visible.has(headings[i].id)) { setActive(headings[i].id); return; } }
    }, { rootMargin: "-70px 0px -60% 0px", threshold: [0, 1] });
    headings.forEach(function (h) { io.observe(h); });
  }

  // Search.
  var input = document.getElementById("search");
  var results = document.getElementById("search-results");
  if (!input || !results) return;
  var index = null, loading = null, sel = -1;
  function load() {
    if (index || loading) return loading;
    loading = fetch("/search-index.json").then(function (r) { return r.json(); }).then(function (d) { index = d; return d; });
    return loading;
  }
  function esc(s) { return s.replace(/[&<>"]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]; }); }
  function mark(s, terms) {
    var out = esc(s);
    terms.forEach(function (t) {
      if (!t) return;
      out = out.replace(new RegExp("(" + t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<mark>$1</mark>");
    });
    return out;
  }
  function snippet(text, terms) {
    var lower = text.toLowerCase(), pos = -1;
    for (var i = 0; i < terms.length; i++) { pos = lower.indexOf(terms[i]); if (pos !== -1) break; }
    if (pos === -1) return text.slice(0, 120);
    var start = Math.max(0, pos - 50);
    return (start ? "… " : "") + text.slice(start, start + 140) + " …";
  }
  function run() {
    var q = input.value.trim().toLowerCase();
    sel = -1;
    if (q.length < 2) { results.hidden = true; results.innerHTML = ""; return; }
    load().then(function (pages) {
      var terms = q.split(/\s+/).filter(Boolean);
      var hits = [];
      pages.forEach(function (p) {
        var title = p.title.toLowerCase(), text = p.text.toLowerCase();
        var score = 0;
        terms.forEach(function (t) {
          if (title.indexOf(t) !== -1) score += 10;
          p.headings.forEach(function (h) { if (h.text.toLowerCase().indexOf(t) !== -1) score += 4; });
          var n = text.split(t).length - 1; if (n) score += Math.min(n, 5);
        });
        var all = terms.every(function (t) { return title.indexOf(t) !== -1 || text.indexOf(t) !== -1; });
        if (score && all) {
          var heading = null;
          for (var i = 0; i < p.headings.length; i++) {
            if (terms.some(function (t) { return p.headings[i].text.toLowerCase().indexOf(t) !== -1; })) { heading = p.headings[i]; break; }
          }
          hits.push({ page: p, score: score, heading: heading });
        }
      });
      hits.sort(function (a, b) { return b.score - a.score; });
      hits = hits.slice(0, 8);
      if (!hits.length) { results.innerHTML = '<div class="empty">No results for "' + esc(input.value.trim()) + '"</div>'; results.hidden = false; return; }
      results.innerHTML = hits.map(function (h) {
        var href = h.page.url + (h.heading && h.heading.text.toLowerCase() !== h.page.title.toLowerCase() ? "#" + h.heading.id : "");
        var label = h.heading && h.heading.text.toLowerCase() !== h.page.title.toLowerCase() ? h.page.title + " › " + h.heading.text : h.page.title;
        return '<a href="' + href + '"><div class="r-title">' + mark(label, terms) + "<small>" + esc(h.page.section) + '</small></div><div class="r-snippet">' + mark(snippet(h.page.text, terms), terms) + "</div></a>";
      }).join("");
      results.hidden = false;
    });
  }
  input.addEventListener("input", run);
  input.addEventListener("focus", function () { load(); if (input.value.trim().length >= 2) results.hidden = false; });
  input.addEventListener("keydown", function (e) {
    var items = results.querySelectorAll("a");
    if (e.key === "Escape") { results.hidden = true; input.blur(); return; }
    if (!items.length) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (sel >= 0) items[sel].classList.remove("active");
      sel = e.key === "ArrowDown" ? (sel + 1) % items.length : (sel - 1 + items.length) % items.length;
      items[sel].classList.add("active"); items[sel].scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && sel >= 0) {
      e.preventDefault(); window.location.href = items[sel].getAttribute("href");
    }
  });
  document.addEventListener("click", function (e) { if (!e.target.closest(".search")) results.hidden = true; });
  document.addEventListener("keydown", function (e) {
    if (e.key === "/" && !/input|textarea|select/i.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); input.select(); }
  });
})();
