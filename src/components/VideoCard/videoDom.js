export function toFileURL(absPath) {
    let p = String(absPath || "");
    p = p.replace(/\\/g, "/");                // normalize slashes
    p = p.replace(/^([A-Za-z]):/, "/$1:");    // ensure "/C:" prefix
    const encoded = encodeURI(p).replace(/#/g, "%23");
    return `file://${encoded}`;
  }
  
  export function hardDetach(el) {
    if (!el) return;
    try { el.pause(); } catch {}
    try {
      if (typeof el.src === "string" && el.src.startsWith("blob:")) {
        try { URL.revokeObjectURL(el.src); } catch {}
      }
      el.removeAttribute("src");
      el.srcObject = null;
      el.load();
    } catch {}
  }
  