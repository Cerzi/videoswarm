export function classifyMediaError(err) {
    const code = err?.code ?? null; // MediaError: 1..4
    const msg = String(err?.message || err || "").toLowerCase();
  
    // Terminal
    if (code === 4) return { terminal: true, label: "File unsupported" }; // MEDIA_ERR_SRC_NOT_SUPPORTED
    if (msg.includes("err_file_not_found") || msg.includes("no supported source") || msg.includes("src not supported")) {
      return { terminal: true, label: "File missing/unsupported" };
    }
    if (code === 3 || msg.includes("decode") || msg.includes("demuxer")) {
      return { terminal: true, label: "Cannot decode this file" }; // MEDIA_ERR_DECODE
    }
  
    // Transient / recoverable
    if (code === 1 || msg.includes("aborted")) return { terminal: false, label: "Load aborted" };
    if (code === 2 || msg.includes("network")) return { terminal: false, label: "Temporary read error" };
    if (msg.includes("play() request was interrupted") || msg.includes("not allowed") || msg.includes("user gesture")) {
      return { terminal: false, label: "Playback interrupted" };
    }
  
    return { terminal: false, label: "Failed to load" };
  }
  