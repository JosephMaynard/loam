import { MeshContactSchema, MeshIdentityCardSchema, type MeshContact, type MeshIdentityCard } from "@loam/schema";
import { useEffect, useId, useMemo, useRef, useState } from "preact/hooks";

import { Avatar } from "../components/Avatar";
import { CardHeader } from "../components/ScreenParts";
import { ScreenHeader } from "../components/ScreenHeader";
import { errorText, t } from "../i18n";
import { fetchJson, REQUEST_TIMEOUT_MS } from "../lib/api";
import { copyText } from "../lib/clipboard";
import { safeQrSvg } from "../lib/qr";
import { encryptedFetch } from "../lib/transport";

/**
 * Parse a `GET /api/mesh/contacts` payload into validated contacts, dropping any entries that fail
 * the schema (mirrors `parseUserList`).
 */
export function parseMeshContactList(payload: unknown): MeshContact[] {
  return Array.isArray(payload)
    ? payload.flatMap((item) => {
        const parsed = MeshContactSchema.safeParse(item);
        return parsed.success ? [parsed.data] : [];
      })
    : [];
}

/**
 * Mesh mail (opportunistic-mesh sealed mailbox — docs/16). Only rendered when
 * `networkConfig.enableMesh` is on. Three panels: this user's own shareable mesh identity card (QR +
 * copy, so someone else can add them as a contact), a paste-a-card form to add a contact, and the
 * contact list with a per-contact compose box for sending sealed mail (delivered to the recipient as
 * an ordinary DM once opened — there is no separate "inbox" here).
 */
export function MeshView() {
  const [card, setCard] = useState<MeshIdentityCard>();
  const [cardLoading, setCardLoading] = useState(true);
  const [cardError, setCardError] = useState<string>();
  const [copied, setCopied] = useState(false);

  const [contacts, setContacts] = useState<MeshContact[]>();
  const [contactsError, setContactsError] = useState<string>();
  const [contactsReloadKey, setContactsReloadKey] = useState(0);

  const [addValue, setAddValue] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string>();
  const [addSuccess, setAddSuccess] = useState<string>();

  const [selectedMeshId, setSelectedMeshId] = useState<string>();
  const [composeBody, setComposeBody] = useState("");
  const [composeBusy, setComposeBusy] = useState(false);
  const [composeError, setComposeError] = useState<string>();
  const [composeSuccess, setComposeSuccess] = useState<string>();

  const addContactId = useId();

  useEffect(() => {
    let active = true;
    setCardLoading(true);
    setCardError(undefined);

    fetchJson<unknown>("/api/mesh/identity")
      .then((payload) => {
        if (!active) {
          return;
        }

        const parsed = MeshIdentityCardSchema.safeParse(payload);
        if (!parsed.success) {
          setCardError(t("mesh.myCardUnrecognised"));
          return;
        }

        setCard(parsed.data);
      })
      .catch((error: unknown) => {
        if (active) {
          setCardError(error instanceof Error ? error.message : t("mesh.myCardLoadError"));
        }
      })
      .finally(() => {
        if (active) {
          setCardLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setContactsError(undefined);

    fetchJson<unknown>("/api/mesh/contacts")
      .then((payload) => {
        if (active) {
          setContacts(parseMeshContactList(payload));
        }
      })
      .catch((error: unknown) => {
        if (active) {
          setContactsError(error instanceof Error ? error.message : t("mesh.contactsLoadError"));
        }
      });

    return () => {
      active = false;
    };
  }, [contactsReloadKey]);

  const cardJson = useMemo(() => (card ? JSON.stringify(card) : undefined), [card]);
  const qrSvg = useMemo(() => safeQrSvg(cardJson, "#16271f"), [cardJson]);

  // Clear the "Copied" flash timer on unmount (the file's cleanup discipline; Preact tolerates a
  // late setState but we match the surrounding effects).
  const copyTimerRef = useRef<number>();
  useEffect(() => () => window.clearTimeout(copyTimerRef.current), []);

  async function copyCard(): Promise<void> {
    if (!cardJson) {
      return;
    }

    // Works on the plain-HTTP LAN too (lib/clipboard.ts). The card is also shown as a selectable
    // read-only field below, so it can always be copied by hand.
    if (await copyText(cardJson)) {
      setCopied(true);
      copyTimerRef.current = window.setTimeout(() => setCopied(false), 2000);
    }
  }

  async function addContact(): Promise<void> {
    let parsedBody: unknown;

    try {
      parsedBody = JSON.parse(addValue);
    } catch {
      setAddError(t("mesh.addContactInvalidJson"));
      return;
    }

    setAddBusy(true);
    setAddError(undefined);
    setAddSuccess(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await encryptedFetch("POST", "/api/mesh/contacts", parsedBody, {
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        throw new Error(errorText(payload, t("mesh.addContactError")));
      }

      setAddValue("");
      setAddSuccess(t("mesh.addContactSuccess"));
      setContactsReloadKey((key) => key + 1);
    } catch (error) {
      setAddError(error instanceof Error ? error.message : t("mesh.addContactError"));
    } finally {
      window.clearTimeout(timeout);
      setAddBusy(false);
    }
  }

  function selectContact(meshId: string): void {
    setSelectedMeshId((current) => (current === meshId ? undefined : meshId));
    setComposeBody("");
    setComposeError(undefined);
    setComposeSuccess(undefined);
  }

  async function sendMail(): Promise<void> {
    const toMeshId = selectedMeshId;
    const body = composeBody.trim();

    if (!toMeshId || !body) {
      return;
    }

    setComposeBusy(true);
    setComposeError(undefined);
    setComposeSuccess(undefined);

    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await encryptedFetch("POST", "/api/mesh/messages", { toMeshId, body }, {
        signal: controller.signal,
      });
      const payload: unknown = await response.json().catch(() => undefined);

      if (!response.ok) {
        throw new Error(errorText(payload, t("mesh.composeError")));
      }

      setComposeBody("");
      setComposeSuccess(t("mesh.composeSuccess"));
    } catch (error) {
      setComposeError(error instanceof Error ? error.message : t("mesh.composeError"));
    } finally {
      window.clearTimeout(timeout);
      setComposeBusy(false);
    }
  }

  return (
    <section className="settings-view">
      <ScreenHeader title={t("mesh.title")} />
      <div className="screen-body">
        <div className="screen-column">
          <div className="card">
            <CardHeader description={t("mesh.myCardNote")} title={t("mesh.myCardTitle")} />
            {cardLoading ? <p className="form-note">{t("mesh.myCardLoading")}</p> : null}
            {cardError ? <p className="notice notice-danger">{cardError}</p> : null}
            {card ? (
              <>
                {qrSvg ? (
                  <div aria-hidden="true" className="qr-tile" dangerouslySetInnerHTML={{ __html: qrSvg }} />
                ) : (
                  <p className="form-note">{t("mesh.myCardQrTooLarge")}</p>
                )}
                {/* Visible, selectable copy of the card so a clipboard-less (insecure-context) browser —
                    the norm on LOAM's plain-HTTP LAN — and screen readers (the QR is aria-hidden) can
                    still get it out, mirroring the join-QR panel's URL fallback. */}
                <textarea
                  aria-label={t("mesh.myCardTitle")}
                  className="textarea mono-field mesh-card-text"
                  onFocus={(event) => event.currentTarget.select()}
                  readOnly
                  rows={3}
                  value={cardJson}
                />
                <div className="card-actions">
                  <button className="btn btn-secondary" onClick={() => void copyCard()} type="button">
                    {copied ? t("mesh.copyCardCopied") : t("mesh.copyCard")}
                  </button>
                </div>
              </>
            ) : null}
          </div>

          <div className="card">
            <CardHeader title={t("mesh.addContactTitle")} />
            <label className="sr-only" for={addContactId}>
              {t("mesh.addContactTitle")}
            </label>
            <textarea
              className="textarea mono-field"
              dir="auto"
              disabled={addBusy}
              id={addContactId}
              onInput={(event) => setAddValue(event.currentTarget.value)}
              placeholder={t("mesh.addContactPlaceholder")}
              rows={4}
              value={addValue}
            />
            {addError ? <p className="form-error">{addError}</p> : null}
            {addSuccess ? <p className="form-note">{addSuccess}</p> : null}
            <div className="card-actions">
              <button
                className="btn btn-primary"
                disabled={addBusy || !addValue.trim()}
                onClick={() => void addContact()}
                type="button"
              >
                {addBusy ? t("mesh.addContactAdding") : t("mesh.addContactButton")}
              </button>
            </div>
          </div>

          <div className="card">
            <CardHeader
              actions={
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() => setContactsReloadKey((key) => key + 1)}
                  type="button"
                >
                  {t("common.refresh")}
                </button>
              }
              title={t("mesh.contactsTitle")}
            />
            {contacts === undefined && !contactsError ? <p className="form-note">{t("mesh.contactsLoading")}</p> : null}
            {contactsError ? <p className="notice notice-danger">{contactsError}</p> : null}
            {contacts && contacts.length === 0 ? <p className="empty-note">{t("mesh.contactsEmpty")}</p> : null}
            {contacts?.length ? (
              <ul className="list">
                {contacts.map((contact) => (
                  <li className="list-row mesh-contact" key={contact.meshId}>
                    <Avatar id={contact.meshId} size="md" />
                    <div className="row-text">
                      <strong className="row-title" dir="auto">
                        {contact.displayName ?? contact.meshId}
                      </strong>
                      {contact.displayName ? <span className="row-meta">{contact.meshId}</span> : null}
                    </div>
                    <button
                      aria-expanded={selectedMeshId === contact.meshId}
                      className={selectedMeshId === contact.meshId ? "btn btn-ghost btn-sm" : "btn btn-secondary btn-sm"}
                      onClick={() => selectContact(contact.meshId)}
                      type="button"
                    >
                      {selectedMeshId === contact.meshId ? t("mesh.composeHide") : t("mesh.composeShow")}
                    </button>
                    {selectedMeshId === contact.meshId ? (
                      <div className="row-detail mesh-compose">
                        <textarea
                          aria-label={t("mesh.composePlaceholder")}
                          className="textarea"
                          dir="auto"
                          disabled={composeBusy}
                          onInput={(event) => setComposeBody(event.currentTarget.value)}
                          placeholder={t("mesh.composePlaceholder")}
                          rows={3}
                          value={composeBody}
                        />
                        <p className="form-note">{t("mesh.composeReplyNote")}</p>
                        {composeError ? <p className="form-error">{composeError}</p> : null}
                        {composeSuccess ? <p className="form-note">{composeSuccess}</p> : null}
                        <div className="card-actions">
                          <button
                            className="btn btn-primary"
                            disabled={composeBusy || !composeBody.trim()}
                            onClick={() => void sendMail()}
                            type="button"
                          >
                            {composeBusy ? t("mesh.composeSending") : t("mesh.composeSend")}
                          </button>
                        </div>
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
