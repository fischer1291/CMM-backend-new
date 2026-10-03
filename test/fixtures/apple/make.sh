#!/bin/sh
# Test certificates for test/apple-notifications.test.js (plan 2.6b): a
# chain shaped like Apple's (EC P-256 root -> intermediate with Apple's
# intermediate OID 1.2.840.113635.100.6.2.1 -> leaf with Apple's
# signing OID 1.2.840.113635.100.6.11.1), a foreign chain under another
# root, and a leaf without the Apple OID. Test only: the keys here sign
# nothing outside the tests, and the production path only ever trusts the
# Apple Root CA G3 embedded in lib/appleRoot.js. Run from anywhere:
#   sh test/fixtures/apple/make.sh
# It overwrites the files; the tests read whatever is there (valid 20 years).
set -eu
cd "$(dirname "$0")"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
DAYS=7300

cat > "$TMP/ext.cnf" <<'CNF'
[root]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
[intermediate]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.840.113635.100.6.2.1 = ASN1:NULL
[leaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
1.2.840.113635.100.6.11.1 = ASN1:NULL
[plainleaf]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid
CNF

key() { openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1.key"; }
root() { # name subject
  key "$1"
  openssl req -new -x509 -key "$1.key" -subj "$2" -days $DAYS -sha256 -config "$TMP/ext.cnf" -extensions root -out "$1.pem"
}
issue() { # name subject issuer section
  key "$1"
  openssl req -new -key "$1.key" -subj "$2" -out "$TMP/$1.csr"
  openssl x509 -req -in "$TMP/$1.csr" -CA "$3.pem" -CAkey "$3.key" -CAcreateserial -CAserial "$TMP/$3.srl" -days $DAYS -sha256 -extfile "$TMP/ext.cnf" -extensions "$4" -out "$1.pem" 2>/dev/null
}

root root "/CN=Test Root CA - G3/O=Wanna yap? Tests"
issue intermediate "/CN=Test Worldwide Developer Relations/O=Wanna yap? Tests" root intermediate
issue leaf "/CN=Test Prod ECC Mac App Store and iTunes Store Receipt Signing/O=Wanna yap? Tests" intermediate leaf
issue plain-leaf "/CN=Test leaf without Apple OID/O=Wanna yap? Tests" intermediate plainleaf

root foreign-root "/CN=Foreign Root CA/O=Somebody else"
issue foreign-intermediate "/CN=Foreign Intermediate/O=Somebody else" foreign-root intermediate
issue foreign-leaf "/CN=Foreign Leaf/O=Somebody else" foreign-intermediate leaf

# Only the leaves' keys are needed to sign test payloads
rm -f root.key intermediate.key foreign-root.key foreign-intermediate.key
