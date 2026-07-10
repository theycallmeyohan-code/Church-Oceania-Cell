(() => {
  const area = document.getElementById("passkeyArea");
  const button = document.getElementById("passkeyLoginBtn");
  const status = document.getElementById("passkeyStatus");
  if (!area || !button || !status || !window.PublicKeyCredential || !navigator.credentials?.get) return;

  button.addEventListener("click", loginWithPasskey);
  checkAvailability();

  async function checkAvailability() {
    try {
      const response = await fetch("/__auth/passkey/options?check=1", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      });
      const result = await response.json().catch(() => ({}));
      if (response.ok && result.available) area.hidden = false;
    } catch {
      area.hidden = true;
    }
  }

  async function loginWithPasskey() {
    button.disabled = true;
    status.textContent = "기기의 지문, 얼굴 또는 화면잠금을 확인하세요.";
    try {
      const optionsResponse = await fetch("/__auth/passkey/options", {
        headers: { Accept: "application/json" },
        cache: "no-store",
        credentials: "same-origin"
      });
      const options = await optionsResponse.json().catch(() => ({}));
      if (!optionsResponse.ok || !options.available || !options.publicKey) {
        throw new Error(options.error || "등록된 패스키가 없습니다.");
      }

      const publicKey = decodeRequestOptions(options.publicKey);
      const credential = await navigator.credentials.get({ publicKey });
      if (!credential) throw new Error("패스키 인증이 취소되었습니다.");

      const loginResponse = await fetch("/__auth/passkey/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(serializeAssertion(credential))
      });
      const result = await loginResponse.json().catch(() => ({}));
      if (!loginResponse.ok) throw new Error(result.error || "패스키 로그인에 실패했습니다.");
      window.location.assign("/");
    } catch (error) {
      status.textContent = passkeyErrorMessage(error);
    } finally {
      button.disabled = false;
    }
  }

  function decodeRequestOptions(publicKey) {
    return {
      ...publicKey,
      challenge: base64UrlToBytes(publicKey.challenge),
      allowCredentials: (publicKey.allowCredentials || []).map((credential) => ({
        ...credential,
        id: base64UrlToBytes(credential.id)
      }))
    };
  }

  function serializeAssertion(credential) {
    return {
      id: credential.id,
      rawId: bytesToBase64Url(credential.rawId),
      type: credential.type,
      response: {
        clientDataJSON: bytesToBase64Url(credential.response.clientDataJSON),
        authenticatorData: bytesToBase64Url(credential.response.authenticatorData),
        signature: bytesToBase64Url(credential.response.signature),
        userHandle: credential.response.userHandle
          ? bytesToBase64Url(credential.response.userHandle)
          : null
      }
    };
  }

  function base64UrlToBytes(value) {
    const base64 = String(value).replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  }

  function bytesToBase64Url(value) {
    const bytes = new Uint8Array(value);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  }

  function passkeyErrorMessage(error) {
    if (error?.name === "NotAllowedError" || error?.name === "AbortError") {
      return "인증이 취소되었거나 제한 시간 안에 완료되지 않았습니다.";
    }
    return error?.message || "패스키 로그인을 완료하지 못했습니다.";
  }
})();
