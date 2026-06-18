// SAML 2.0 Service Provider (SP) helpers.
//
// The dashboard authenticates against an external SAML Identity Provider (IdP) —
// e.g. the companion Stemlab-SSO IdP. This module is the SP half:
//
//   - buildAuthnRequest()        — a deflate+base64 AuthnRequest for the
//                                  HTTP-Redirect binding (the IdP inflates it with
//                                  zlib.inflateRaw, so we deflateRaw to match).
//   - parseAndVerifySamlResponse() — base64-decode the HTTP-POST SAMLResponse,
//                                  verify the enveloped XML signature on the
//                                  Assertion against the configured IdP cert, run
//                                  the standard SAML conditions checks, and pull
//                                  out the username/email/name/role attributes.
//   - buildSpMetadata()          — SP metadata (SPSSODescriptor) generated from
//                                  the saved entity id + ACS URL.
//   - validation helpers         — URL and X.509 PEM format checks used before a
//                                  config is saved.
//
// The signature is verified against the *stored* certificate only — the cert
// embedded in the assertion's KeyInfo (if any) is ignored — and attributes are
// read from the specific Assertion node the signature covers, which together
// defend against XML signature-wrapping. The SP does not sign its AuthnRequests
// (the IdP advertises WantAuthnRequestsSigned="false").

import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { DOMParser } from '@xmldom/xmldom';
import xpath from 'xpath';
import { SignedXml } from 'xml-crypto';

const SAML_PROTOCOL_NS = 'urn:oasis:names:tc:SAML:2.0:protocol';
const SAML_ASSERTION_NS = 'urn:oasis:names:tc:SAML:2.0:assertion';
const DSIG_NS = 'http://www.w3.org/2000/09/xmldsig#';
const BINDING_REDIRECT = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect';
const BINDING_POST = 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST';
const NAMEID_EMAIL = 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress';
const STATUS_SUCCESS = 'urn:oasis:names:tc:SAML:2.0:status:Success';

// Small clock-skew allowance so a slightly-off IdP/SP clock doesn't reject an
// otherwise-valid assertion at the NotBefore/NotOnOrAfter boundaries.
const CLOCK_SKEW_MS = 3 * 60 * 1000;

// ---------------------------------------------------------------------------
// Validation helpers (used by the settings PUT before persisting).
// ---------------------------------------------------------------------------

// An http(s) absolute URL. Reject anything else (javascript:, relative, etc.).
export function isValidHttpUrl(value) {
  if (typeof value !== 'string' || !value.trim()) {
    return false;
  }
  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

// Pull the base64 DER body out of a PEM cert (or a bare base64 blob).
export function certBody(certificate) {
  return String(certificate || '')
    .replace(/-----BEGIN CERTIFICATE-----/g, '')
    .replace(/-----END CERTIFICATE-----/g, '')
    .replace(/\s+/g, '');
}

// Wrap a bare base64 cert body in PEM armor, or return an already-PEM cert as-is.
// xml-crypto wants a PEM string for the public cert.
export function normalizeCertificatePem(certificate) {
  const raw = String(certificate || '').trim();
  if (/-----BEGIN CERTIFICATE-----/.test(raw)) {
    return raw;
  }
  const body = certBody(raw);
  if (!body) {
    return '';
  }
  const lines = body.match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

// A plausible X.509 certificate: a base64 body that decodes to a DER sequence
// (starts with 0x30). We don't fully parse the cert — just enough to reject
// obviously malformed paste.
export function isValidCertificate(certificate) {
  const body = certBody(certificate);
  if (body.length < 64 || !/^[A-Za-z0-9+/=]+$/.test(body)) {
    return false;
  }
  try {
    const der = Buffer.from(body, 'base64');
    return der.length > 16 && der[0] === 0x30;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// AuthnRequest (SP → IdP, HTTP-Redirect binding).
// ---------------------------------------------------------------------------

function uid() {
  return `_${randomBytes(16).toString('hex')}`;
}

function nowIso(date = new Date()) {
  return date.toISOString().replace(/\.\d+Z$/, 'Z');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// Build a redirect URL to the IdP's SSO endpoint carrying a DEFLATE+base64
// AuthnRequest (and an optional RelayState). Returns { url, requestId } so the
// caller can bind the request id into its signed RelayState for InResponseTo
// validation on the way back.
export function buildAuthnRequest({ spEntityId, acsUrl, idpSsoUrl, relayState }) {
  const requestId = uid();
  const xml =
    `<samlp:AuthnRequest xmlns:samlp="${SAML_PROTOCOL_NS}" xmlns:saml="${SAML_ASSERTION_NS}"` +
    ` ID="${requestId}" Version="2.0" IssueInstant="${nowIso()}"` +
    ` Destination="${escapeXml(idpSsoUrl)}"` +
    ` AssertionConsumerServiceURL="${escapeXml(acsUrl)}"` +
    ` ProtocolBinding="${BINDING_POST}">` +
    `<saml:Issuer>${escapeXml(spEntityId)}</saml:Issuer>` +
    `</samlp:AuthnRequest>`;

  const deflated = zlib.deflateRawSync(Buffer.from(xml, 'utf8')).toString('base64');
  const url = new URL(idpSsoUrl);
  url.searchParams.set('SAMLRequest', deflated);
  if (relayState) {
    url.searchParams.set('RelayState', relayState);
  }
  return { url: url.toString(), requestId };
}

// ---------------------------------------------------------------------------
// SAMLResponse (IdP → SP, HTTP-POST binding) parse + verify.
// ---------------------------------------------------------------------------

function selectNs(query, node) {
  const select = xpath.useNamespaces({
    samlp: SAML_PROTOCOL_NS,
    saml: SAML_ASSERTION_NS,
    ds: DSIG_NS,
  });
  return select(query, node);
}

function textOf(node) {
  return node && node.textContent ? node.textContent.trim() : '';
}

// Verify the enveloped signature over the Assertion using the configured cert.
// Returns true only when exactly the assertion node is signed and the digest +
// signature both check out against `certPem`.
function verifyAssertionSignature(xml, doc, assertionNode, certPem) {
  // The signature may sit on the Response or the Assertion; the IdP signs the
  // Assertion. Find a Signature that is a direct child of the assertion node.
  const signatures = selectNs(".//ds:Signature", assertionNode).filter(
    (sig) => sig.parentNode === assertionNode,
  );
  if (signatures.length !== 1) {
    return false;
  }

  const sig = new SignedXml();
  sig.publicCert = certPem;
  // Trust only the configured cert — never a cert embedded in the document.
  sig.getCertFromKeyInfo = () => certPem;
  sig.loadSignature(signatures[0]);

  let valid = false;
  try {
    valid = sig.checkSignature(xml);
  } catch {
    return false;
  }
  if (!valid) {
    return false;
  }

  // Guard against signature wrapping: the validated reference must point at the
  // assertion we are about to read attributes from.
  const assertionId = assertionNode.getAttribute('ID');
  const references = sig.getReferences ? sig.getReferences() : sig.references;
  return (
    Array.isArray(references) &&
    references.some((ref) => {
      const uri = String(ref.uri || ref.xpath || '').replace(/^#/, '');
      return uri === '' || uri === assertionId;
    })
  );
}

function withinWindow(notBefore, notOnOrAfter, now) {
  if (notBefore) {
    const start = Date.parse(notBefore);
    if (Number.isFinite(start) && now + CLOCK_SKEW_MS < start) {
      return false;
    }
  }
  if (notOnOrAfter) {
    const end = Date.parse(notOnOrAfter);
    if (Number.isFinite(end) && now - CLOCK_SKEW_MS >= end) {
      return false;
    }
  }
  return true;
}

class SamlError extends Error {}

// Parse + fully validate a base64 SAMLResponse. Throws SamlError with a short
// reason on any failure; returns { username, email, name, role } on success.
//
// `expectedInResponseTo` (optional) ties the response to an AuthnRequest we
// issued (carried in our signed RelayState). When provided it must match.
export function parseAndVerifySamlResponse({
  samlResponseB64,
  idpCertificate,
  spEntityId,
  acsUrl,
  expectedInResponseTo,
}) {
  const certPem = normalizeCertificatePem(idpCertificate);
  if (!certPem) {
    throw new SamlError('No IdP certificate configured');
  }

  let xml;
  try {
    xml = Buffer.from(String(samlResponseB64 || ''), 'base64').toString('utf8');
  } catch {
    throw new SamlError('Malformed SAMLResponse encoding');
  }
  if (!xml || !/<.+>/.test(xml)) {
    throw new SamlError('Empty SAMLResponse');
  }

  const doc = new DOMParser({
    errorHandler: { warning() {}, error() {}, fatalError() {} },
  }).parseFromString(xml, 'text/xml');

  const response = selectNs('/samlp:Response', doc)[0];
  if (!response) {
    throw new SamlError('Not a SAML Response');
  }

  // Status must be Success.
  const statusCode = selectNs('./samlp:Status/samlp:StatusCode', response)[0];
  if (!statusCode || statusCode.getAttribute('Value') !== STATUS_SUCCESS) {
    throw new SamlError('IdP returned a non-success status');
  }

  const assertion = selectNs('./saml:Assertion', response)[0];
  if (!assertion) {
    throw new SamlError('No assertion in response');
  }

  // Signature (over the assertion) against the configured cert.
  if (!verifyAssertionSignature(xml, doc, assertion, certPem)) {
    throw new SamlError('Assertion signature verification failed');
  }

  const now = Date.now();

  // Conditions: time window + audience must be our SP entity id.
  const conditions = selectNs('./saml:Conditions', assertion)[0];
  if (conditions) {
    if (
      !withinWindow(
        conditions.getAttribute('NotBefore'),
        conditions.getAttribute('NotOnOrAfter'),
        now,
      )
    ) {
      throw new SamlError('Assertion is outside its validity window');
    }
    const audiences = selectNs(
      './saml:AudienceRestriction/saml:Audience',
      conditions,
    ).map(textOf);
    if (audiences.length > 0 && spEntityId && !audiences.includes(spEntityId)) {
      throw new SamlError('Assertion audience does not match the SP entity ID');
    }
  }

  // SubjectConfirmationData: recipient/InResponseTo/expiry checks.
  const scd = selectNs(
    './saml:Subject/saml:SubjectConfirmation/saml:SubjectConfirmationData',
    assertion,
  )[0];
  if (scd) {
    const recipient = scd.getAttribute('Recipient');
    if (recipient && acsUrl && recipient !== acsUrl) {
      throw new SamlError('Assertion recipient does not match the ACS URL');
    }
    if (!withinWindow(null, scd.getAttribute('NotOnOrAfter'), now)) {
      throw new SamlError('Subject confirmation has expired');
    }
    const inResponseTo = scd.getAttribute('InResponseTo');
    if (expectedInResponseTo && inResponseTo && inResponseTo !== expectedInResponseTo) {
      throw new SamlError('InResponseTo does not match the AuthnRequest');
    }
  }

  // Identity: NameID (email) + attributes.
  const nameId = textOf(selectNs('./saml:Subject/saml:NameID', assertion)[0]);
  const attributes = {};
  for (const attr of selectNs('./saml:AttributeStatement/saml:Attribute', assertion)) {
    const name = attr.getAttribute('Name');
    const value = textOf(selectNs('./saml:AttributeValue', attr)[0]);
    if (name) {
      attributes[name.toLowerCase()] = value;
    }
  }

  const email = (attributes.email || nameId || '').trim().toLowerCase();
  if (!email) {
    throw new SamlError('Assertion carries no email/NameID');
  }

  return {
    username: (attributes.username || email).trim(),
    email,
    name: (attributes.name || email).trim(),
    role: (attributes.role || '').trim().toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// SP metadata (served at /api/auth/saml/metadata).
// ---------------------------------------------------------------------------

export function buildSpMetadata({ spEntityId, acsUrl }) {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${escapeXml(spEntityId)}">` +
    `<md:SPSSODescriptor AuthnRequestsSigned="false" WantAssertionsSigned="true"` +
    ` protocolSupportEnumeration="${SAML_PROTOCOL_NS}">` +
    `<md:NameIDFormat>${NAMEID_EMAIL}</md:NameIDFormat>` +
    `<md:AssertionConsumerService Binding="${BINDING_POST}"` +
    ` Location="${escapeXml(acsUrl)}" index="0" isDefault="true"/>` +
    `</md:SPSSODescriptor>` +
    `</md:EntityDescriptor>`
  );
}

export { SamlError, BINDING_REDIRECT };
