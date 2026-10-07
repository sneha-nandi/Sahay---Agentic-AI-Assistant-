"""Deterministic safety layer: redaction, prompt-injection screening, action risk.

Nothing in here asks the LLM. The model proposes, these rules decide how risky a
proposal is, so a manipulated or confused model can't lower an action's risk level.
Everything a web page controls (labels, button text, links) is treated as a claim
that can lie, so anything that can change data or leave the site needs approval.
"""

import re
import unicodedata
from urllib.parse import urljoin, urlsplit

ACTION_TYPES = {"highlight", "navigate", "click", "fill", "select", "upload", "submit"}
TEXT_INPUT_TYPES = {None, "", "text", "email", "tel", "number", "url", "search", "date", "month", "week", "time", "datetime-local", "textarea"}

SENSITIVE_FIELD = re.compile(
    r"password|passcode|\botp\b|one.time|\bm?pin\b(?!.?code)|cvv|cvc|card.?(no|num)|credit|debit|expir|"
    r"aadhaa?r|\buid\b|\bpan\b|ssn|social.security|passport|voter|\bepic\b|licen[cs]e|"
    r"\bid.?(no|num)|identity|national.id|tax.?id|\bgstin?\b|\btin\b|"
    r"account.?(no|num)|ifsc|routing|iban|swift|sort.?code|\bupi\b|\bbank\b|"
    r"date.of.birth|\bdob\b|birth.?date|maiden|security.(question|answer)|signature|secret",
    re.I,
)
# Numbers that look like ID/card/account/phone numbers, Indian PAN numbers, and email addresses.
SENSITIVE_TEXT = re.compile(r"\b(?:\d[ -]?){9,19}\b|\b[A-Z]{5}\d{4}[A-Z]\b|[\w.+-]+@[\w-]+\.[\w.-]+")

INJECTION = re.compile(
    r"ignore (?:all |any |the )?(?:previous|prior|above|earlier|preceding) (?:instructions|prompts?|rules|directions)|"
    r"disregard (?:all |any |the )?(?:previous|prior|above|your|earlier) (?:instructions|rules|prompts?)|"
    r"forget (?:all |your )?(?:previous |prior )?instructions|"
    r"(?:new|updated|override) (?:system )?(?:instructions?|prompt) *:|system prompt|you are now|"
    r"(?:note|message|instructions?|attention) (?:to|for) (?:the |all |any )?(?:ai|assistant|agent|llm|model|bot|gpt|gemini|claude)s?\b|"
    r"\b(?:ai|llm) (?:assistant|agent)s?,? (?:must|should|please)|"
    r"do not (?:tell|inform|ask|alert|warn) the user|without (?:asking|telling|informing|alerting|confirming with) the user|"
    r"(?:submit|approve|pay|transfer|confirm|click|delete)\b[^.\n]{0,40}\b(?:immediately|automatically|right now|without)",
    re.I,
)

SUBMIT_WORDS = re.compile(r"submit|apply|send|confirm|finish|complete|register|sign.?up|save and|proceed|place order|authori[sz]e", re.I)
CRITICAL_WORDS = re.compile(
    r"\bpay|payment|purchase|\bbuy\b|checkout|transfer|donate|delete|remove|withdraw|unsubscribe|"
    r"cancel (?:my |the )?(?:application|account|registration|order|subscription)|deactivate|close.?account|irreversible",
    re.I,
)
PAYMENT_PAGE = re.compile(r"pay now|payment|amount (?:payable|due)|cannot be undone|irreversible|permanently delete", re.I)
CONSENT_WORDS = re.compile(r"declar|agree|consent|accept|terms|certify|undertak|authori[sz]", re.I)
INVISIBLE = re.compile(r"[­᠎​-‏‪-‮⁠-⁤﻿]")


def normalize(text: str) -> str:
    """Undo tricks used to dodge pattern matching: look-alike characters, zero-width
    characters and unusual spacing."""
    text = INVISIBLE.sub("", unicodedata.normalize("NFKC", str(text)))
    return "\n".join(re.sub(r"[^\S\n]+", " ", line).strip() for line in text.splitlines())


def redact(text: str) -> str:
    return SENSITIVE_TEXT.sub("[REDACTED]", normalize(text))


def redact_url(url: str) -> str:
    """Query strings and fragments often carry tokens or personal data; the model only needs the path."""
    parts = urlsplit(str(url)[:2048])
    return redact(f"{parts.scheme}://{parts.netloc}{parts.path}" + ("?..." if parts.query else "")) if parts.netloc else redact(parts.path)


def host(url: str) -> str:
    """host[:port] without any user:password@ prefix, lowercased."""
    try:
        parts = urlsplit(url)
        return f"{(parts.hostname or '').lower()}{f':{parts.port}' if parts.port else ''}"
    except ValueError:
        return ""


def is_sensitive(el: dict) -> bool:
    if el.get("type") in ("password", "file"):
        return True
    return bool(SENSITIVE_FIELD.search(normalize(" ".join(str(el.get(k) or "") for k in ("label", "name", "autocomplete")))))


def screen_text(text: str) -> tuple[str, list[str]]:
    """Cut out suspected injected instructions and redact ID-like numbers and emails.
    Each line is checked alone and joined with its neighbour, so an instruction split
    across two lines is still caught. Returns (clean text, flagged snippets)."""
    lines = normalize(text).splitlines()
    bad = set()
    for i, line in enumerate(lines):
        if INJECTION.search(line):
            bad.add(i)
        elif i and any(m.start() < len(lines[i - 1]) < m.end() for m in INJECTION.finditer(f"{lines[i - 1]} {line}")):
            bad |= {i - 1, i}
    flags = [lines[i][:200] for i in sorted(bad)]
    clean = "\n".join("[removed: suspected prompt injection]" if i in bad else line for i, line in enumerate(lines))
    return redact(clean), flags


def sanitize_page(page: dict) -> dict:
    """The view of a page the LLM is allowed to see: no field values, no ID numbers or
    emails, no URL query strings, injections cut out."""
    text, flags = screen_text(page.get("text") or "")
    title, title_flags = screen_text(page.get("title") or "")
    flags += title_flags
    elements = []
    for el in (page.get("elements") or [])[:150]:
        label, label_flags = screen_text(str(el.get("label") or el.get("text") or "")[:300])
        flags += label_flags
        view = {k: el[k] for k in ("id", "kind", "type", "required") if el.get(k) not in (None, "", False)}
        view["label"] = label[:120]
        if el.get("href"):
            view["href"] = redact_url(el["href"])[:300]
        if el.get("kind") in ("input", "textarea", "select", "file"):
            view["filled"] = bool(el.get("value") or el.get("checked") or el.get("files"))
            view["sensitive"] = is_sensitive(el)
        if el.get("options"):
            options = [screen_text(str(o)[:80]) for o in el["options"][:30]]
            view["options"] = [o for o, _ in options]
            flags += [f for _, fl in options for f in fl]
        elements.append(view)
    return {
        "url": redact_url(page.get("url", "")),
        "title": title[:300],
        "text": text[:8000],
        "elements": elements,
        "injection_flags": flags,
    }


def find(page: dict, element_id: str | None) -> dict | None:
    return next((el for el in page.get("elements") or [] if el.get("id") == element_id), None)


def assess(action: dict, page: dict, profile: dict) -> dict:
    """Validate and classify one proposed action. Returns the action enriched with
    risk, problem (why it can't run as-is) and the details an approval card needs."""
    a = dict(action)
    a["problem"] = None
    kind = a.get("type")
    el = find(page, a.get("target_id"))
    site = host(page.get("url", ""))
    a["site"] = site
    a["target_label"] = (el.get("label") or el.get("text")) if el else a.get("url")
    if el:
        a["target_kind"] = f"{el.get('kind')}{f' ({el.get('type')})' if el.get('type') else ''}"
        a["expect"] = {"kind": el.get("kind"), "type": el.get("type"), "label": el.get("label")}
    target_text = normalize(f"{el.get('label') or el.get('text') or ''} {el.get('name') or ''}") if el else ""

    if kind not in ACTION_TYPES:
        return {**a, "risk": "critical", "problem": f"Unknown action type '{kind}'."}
    if kind != "navigate" and not el:
        return {**a, "risk": "high", "problem": "The target element does not exist on this page."}
    wrong_kind = {
        "fill": not (el and el.get("kind") in ("input", "textarea") and el.get("type") in TEXT_INPUT_TYPES),
        "select": not (el and el.get("kind") == "select"),
        "upload": not (el and el.get("kind") == "file"),
    }.get(kind)
    if wrong_kind:
        return {**a, "risk": "high", "problem": f"A {kind} action can't be used on a {a.get('target_kind')}."}

    # Resolve the value: profile values and clarification answers come from the user, literal values from the model.
    if kind in ("fill", "select"):
        if a.get("profile_key"):
            a["value"] = profile.get(a["profile_key"]) or None
            a["value_source"] = "your saved profile"
        elif a.get("value") and a.get("value_source") != "you":
            a["value_source"] = "suggested by the assistant"
        if not a.get("value"):
            a["problem"] = "missing_value"

    risk = {"highlight": "low", "navigate": "low", "click": "medium", "fill": "medium", "select": "medium",
            "upload": "high", "submit": "high"}[kind]
    reasons = []

    if kind == "navigate" or (kind == "click" and el.get("kind") == "link"):
        raw = a.get("url") if kind == "navigate" else el.get("href")
        dest = urljoin(page.get("url", ""), raw or "")
        if urlsplit(dest).scheme not in ("http", "https"):
            if kind == "navigate":
                return {**a, "risk": "critical", "problem": "Only http(s) links can be opened."}
            reasons.append("this link runs a script on the page instead of opening a page")
        else:
            risk = "low"
            if kind == "navigate":
                a["url"] = dest
            if host(dest) != site:
                risk, reasons = "medium", reasons + [f"leaves {site} for {host(dest)}"]
        if CRITICAL_WORDS.search(normalize(dest)):
            risk = "critical"
    elif kind == "click":
        reasons.append("buttons can trigger actions on the website")
        if el.get("type") in ("submit", "image") or SUBMIT_WORDS.search(target_text):
            risk = "high"
        if el.get("type") in ("checkbox", "radio") and CONSENT_WORDS.search(target_text):
            risk, reasons = "high", reasons + ["this is a legal declaration or consent"]

    if kind in ("fill", "select") and is_sensitive(el):
        a["problem"] = "sensitive_field"
        risk = "high"
    if kind in ("fill", "select") and a.get("value_source") == "suggested by the assistant":
        reasons.append("value was not taken from your profile")
    if kind in ("click", "submit") and CRITICAL_WORDS.search(target_text):
        risk = "critical"
    if kind == "submit" or (kind == "click" and el.get("type") in ("submit", "image")):
        a["sends_to"] = host(el.get("form_action") or page.get("url", "")) or site
        if a["sends_to"] != site:
            risk, reasons = "critical", reasons + [f"sends the form data to a different website ({a['sends_to']})"]
    if kind == "submit" and PAYMENT_PAGE.search(normalize(page.get("text", "") + " " + page.get("title", ""))):
        risk, reasons = "critical", reasons + ["the page mentions payment or irreversible changes"]

    a["risk"] = risk
    a["risk_reasons"] = reasons
    a["consequences"] = consequences(a)
    return a


def consequences(a: dict) -> str:
    return {
        "highlight": "The element is scrolled into view and highlighted. Nothing is changed.",
        "navigate": f"Your tab will open {a.get('url')}. Unsaved changes on this page may be lost.",
        "click": "This will be clicked. The website decides what happens; it may change or send data. The label shown comes from the website.",
        "fill": f"The field '{a.get('target_label')}' will be set to the value shown, and the website can read it. You can still edit it.",
        "select": f"The option shown will be chosen for '{a.get('target_label')}'. You can still change it.",
        "upload": "The upload field is highlighted so you can pick the file yourself. Sahay never reads your files.",
        "submit": f"The form will be sent to {a.get('sends_to') or 'the website'}. This usually cannot be undone and may be legally binding.",
    }[a["type"]] + (" This action is irreversible or involves money." if a.get("risk") == "critical" else "")


def needs_approval(a: dict, intent_kind: str) -> bool:
    """Only three things run without asking, and only when nothing was flagged:
    highlighting; opening a same-site link when the user asked to navigate/click;
    filling a non-sensitive field from the user's profile when the user asked to fill.
    Everything else (all button clicks, uploads, submits, other sites) asks."""
    if a.get("risk_reasons") or a["risk"] in ("high", "critical"):
        return True
    if a["type"] == "highlight":
        return False
    if a["risk"] == "low" and a["type"] in ("navigate", "click"):
        return intent_kind not in ("navigate", "click")
    if a["type"] in ("fill", "select"):
        return not (intent_kind == "fill" and a.get("value_source") in ("your saved profile", "you"))
    return True
