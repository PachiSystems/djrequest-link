// Progressive enhancement only: copy buttons on code blocks and OS tabs.
// Everything on these pages is readable without JavaScript.
(function () {
  "use strict";

  document.querySelectorAll("pre").forEach(function (pre) {
    if (!navigator.clipboard) return;
    var button = document.createElement("button");
    button.className = "copy";
    button.type = "button";
    button.textContent = "Copy";
    button.addEventListener("click", function () {
      // Copy commands only: skip prompts and comments.
      var clone = pre.cloneNode(true);
      clone.querySelectorAll(".p, .c, .copy").forEach(function (el) { el.remove(); });
      var text = clone.textContent.split("\n").map(function (l) { return l.replace(/\s+$/, ""); })
        .filter(Boolean).join("\n");
      navigator.clipboard.writeText(text).then(function () {
        button.textContent = "Copied";
        setTimeout(function () { button.textContent = "Copy"; }, 1500);
      });
    });
    pre.appendChild(button);
  });

  var preferred = /Win/.test(navigator.platform || navigator.userAgent) ? "windows" : "unix";
  document.querySelectorAll(".tabs").forEach(function (group) {
    var tabs = group.querySelectorAll('[role="tab"]');
    function select(tab) {
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", String(on));
        t.tabIndex = on ? 0 : -1;
        document.getElementById(t.getAttribute("aria-controls")).hidden = !on;
      });
    }
    tabs.forEach(function (tab, i) {
      tab.addEventListener("click", function () { select(tab); });
      tab.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        var next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        next.focus();
        select(next);
      });
    });
    var initial = Array.prototype.find.call(tabs, function (t) { return t.dataset.os === preferred; }) || tabs[0];
    select(initial);
  });
})();
