# Fixture di firma per i test SDI

`test-signing-cert.pem` e `test-signing-key.pem` sono una coppia X.509
**self-signed generata apposta per i test**, con issuer
`CN=flowforge-test-signer, O=FlowForge Test CA, C=IT` e serial `305419896`.

Servono perché `parseCertMetadata` estragga issuer e serial **veri** invece del
ripiego «Unknown/1»: senza un certificato realmente parsabile, quel test
verificherebbe il ripiego e non il codice.

**Non hanno alcun valore.** Non firmano niente fuori da questi test, non sono
mai state usate in produzione, e non corrispondono ad alcuna identità. Sono
qui per lo stesso motivo per cui Node.js tiene le sue: un test che genera un
certificato al volo dipende da `openssl` presente sulla macchina, e un test
che si salta in silenzio è peggio di un test che non c'è.
