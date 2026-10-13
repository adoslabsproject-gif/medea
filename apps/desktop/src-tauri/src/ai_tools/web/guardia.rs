//! Dove l'assistente NON può andare.
//!
//! Chi decide l'indirizzo da aprire è un modello, e quello che il modello
//! legge lo scrivono anche degli estranei: un'email, una pagina. Senza un
//! controllo, «apri http://192.168.1.1/» farebbe leggere a Medea il router di
//! casa, e «apri http://127.0.0.1:39100/…» il motore dei workflow con dentro
//! le chiavi dell'utente.
//!
//! La regola è una: si esce solo verso internet. Niente macchina locale,
//! niente rete di casa o d'ufficio, niente reti private virtuali.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr, ToSocketAddrs};

use anyhow::{anyhow, bail, Result};
use url::Url;

/// Un indirizzo controllato, con gli IP a cui è lecito collegarsi.
///
/// Gli IP viaggiano insieme all'indirizzo perché il collegamento va fatto
/// proprio a quelli: risolvere il nome una seconda volta darebbe a chi
/// controlla il DNS il modo di rispondere «pubblico» al controllo e
/// «127.0.0.1» al collegamento.
#[derive(Debug, Clone)]
pub struct Destinazione {
    pub url: Url,
    pub host: String,
    pub indirizzi: Vec<SocketAddr>,
}

fn v4_pubblico(ip: Ipv4Addr) -> bool {
    let [a, b, ..] = ip.octets();
    !(ip.is_loopback()
        || ip.is_private()
        || ip.is_link_local()
        || ip.is_unspecified()
        || ip.is_broadcast()
        || ip.is_multicast()
        || ip.is_documentation()
        // 100.64.0.0/10: reti condivise dagli operatori, e Tailscale.
        || (a == 100 && (64..128).contains(&b))
        // 192.0.0.0/24 e 198.18.0.0/15: protocolli e banchi di prova.
        || (a == 192 && b == 0 && ip.octets()[2] == 0)
        || (a == 198 && (18..20).contains(&b))
        // 240.0.0.0/4: riservato.
        || a >= 240)
}

fn v6_pubblico(ip: Ipv6Addr) -> bool {
    if let Some(v4) = ip.to_ipv4_mapped() {
        return v4_pubblico(v4);
    }
    let primo = ip.segments()[0];
    !(ip.is_loopback()
        || ip.is_unspecified()
        || ip.is_multicast()
        // fc00::/7: indirizzi locali unici.
        || (primo & 0xfe00) == 0xfc00
        // fe80::/10: locali al collegamento.
        || (primo & 0xffc0) == 0xfe80
        // 2001:db8::/32: documentazione.
        || (primo == 0x2001 && ip.segments()[1] == 0x0db8))
}

/// Vero se l'IP sta su internet e non su una rete interna.
pub fn ip_pubblico(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => v4_pubblico(v4),
        IpAddr::V6(v6) => v6_pubblico(v6),
    }
}

/// Controlla la forma dell'indirizzo, senza toccare la rete.
pub fn analizza(grezzo: &str) -> Result<Url> {
    let url = Url::parse(grezzo.trim()).map_err(|e| anyhow!("indirizzo non valido: {e}"))?;
    if !matches!(url.scheme(), "http" | "https") {
        bail!("si possono aprire solo indirizzi http e https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        bail!("un indirizzo con dentro nome utente o password non si apre");
    }
    if url.host_str().unwrap_or_default().is_empty() {
        bail!("l'indirizzo non ha un nome di sito");
    }
    Ok(url)
}

/// Controlla che tutti gli IP risolti siano pubblici.
///
/// Tutti, non «almeno uno»: un nome che risponde con un IP pubblico e uno
/// interno è esattamente il trucco che questo controllo deve fermare.
pub fn controlla_indirizzi(host: &str, indirizzi: Vec<SocketAddr>) -> Result<Vec<SocketAddr>> {
    if indirizzi.is_empty() {
        bail!("il sito «{host}» non esiste o non risponde al DNS");
    }
    if let Some(interno) = indirizzi.iter().find(|a| !ip_pubblico(a.ip())) {
        bail!(
            "«{host}» porta a un indirizzo interno ({}): l'assistente apre solo siti su internet",
            interno.ip()
        );
    }
    Ok(indirizzi)
}

/// Controlla l'indirizzo e risolve il nome: il risultato è ciò a cui
/// collegarsi, e nient'altro.
pub fn destinazione(grezzo: &str) -> Result<Destinazione> {
    let url = analizza(grezzo)?;
    let host = url
        .host_str()
        .ok_or_else(|| anyhow!("l'indirizzo non ha un nome di sito"))?
        .to_string();
    let porta = url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("porta sconosciuta"))?;
    // Le parentesi di un IPv6 letterale non fanno parte del nome da risolvere.
    let nome = host.trim_start_matches('[').trim_end_matches(']');
    let risolti: Vec<SocketAddr> = (nome, porta)
        .to_socket_addrs()
        .map_err(|e| anyhow!("il sito «{host}» non si risolve: {e}"))?
        .collect();
    let indirizzi = controlla_indirizzi(&host, risolti)?;
    Ok(Destinazione {
        url,
        host,
        indirizzi,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ip(testo: &str) -> IpAddr {
        testo.parse().expect("un IP")
    }

    #[test]
    fn la_macchina_locale_e_le_reti_di_casa_non_sono_internet() {
        for interno in [
            "127.0.0.1",
            "127.8.9.10",
            "10.0.0.5",
            "172.16.4.1",
            "172.31.255.255",
            "192.168.1.1",
            "169.254.169.254",
            "0.0.0.0",
            "255.255.255.255",
            "224.0.0.1",
            "::1",
            "::",
            "fe80::1",
            "fd12:3456::1",
            "fc00::1",
            "ff02::1",
        ] {
            assert!(!ip_pubblico(ip(interno)), "{interno} è passato");
        }
    }

    /// Tailscale dà alle macchine indirizzi 100.64–100.127: su quella rete ci
    /// sono i server di casa e dell'ufficio, raggiungibili senza password.
    #[test]
    fn le_reti_private_virtuali_non_sono_internet() {
        assert!(!ip_pubblico(ip("100.64.0.1")));
        assert!(!ip_pubblico(ip("100.100.50.25")));
        assert!(!ip_pubblico(ip("100.127.255.255")));
        // Appena fuori dall'intervallo si torna su internet.
        assert!(ip_pubblico(ip("100.63.255.255")));
        assert!(ip_pubblico(ip("100.128.0.1")));
    }

    /// `::ffff:127.0.0.1` è la macchina locale scritta in un altro modo.
    #[test]
    fn un_ipv4_travestito_da_ipv6_si_giudica_per_quello_che_e() {
        assert!(!ip_pubblico(ip("::ffff:127.0.0.1")));
        assert!(!ip_pubblico(ip("::ffff:192.168.1.1")));
        assert!(ip_pubblico(ip("::ffff:8.8.8.8")));
    }

    #[test]
    fn un_indirizzo_di_internet_passa() {
        for pubblico in ["8.8.8.8", "1.1.1.1", "93.184.216.34", "2606:4700::1111"] {
            assert!(ip_pubblico(ip(pubblico)), "{pubblico} è stato fermato");
        }
    }

    #[test]
    fn si_aprono_solo_http_e_https() {
        assert!(analizza("https://example.com/pagina").is_ok());
        assert!(analizza("  http://example.com  ").is_ok());
        for no in [
            "file:///etc/passwd",
            "ftp://example.com/",
            "javascript:alert(1)",
            "data:text/html,ciao",
            "example.com",
            "",
        ] {
            assert!(analizza(no).is_err(), "{no} è passato");
        }
    }

    /// `https://banca.it@sito-altrui.example/` si legge come la banca e porta
    /// altrove.
    #[test]
    fn un_indirizzo_con_credenziali_dentro_non_si_apre() {
        assert!(analizza("https://utente:segreto@example.com/").is_err());
        assert!(analizza("https://banca.it@example.com/").is_err());
    }

    #[test]
    fn basta_un_ip_interno_fra_quelli_risolti_per_fermarsi() {
        let pubblico: SocketAddr = "93.184.216.34:443".parse().expect("indirizzo");
        let interno: SocketAddr = "127.0.0.1:443".parse().expect("indirizzo");
        assert!(controlla_indirizzi("example.com", vec![pubblico]).is_ok());
        let errore = controlla_indirizzi("trucco.example", vec![pubblico, interno])
            .expect_err("doveva fermarsi");
        assert!(errore.to_string().contains("indirizzo interno"));
    }

    #[test]
    fn un_nome_che_non_risolve_niente_e_un_errore() {
        assert!(controlla_indirizzi("niente.example", vec![]).is_err());
    }

    /// Senza rete: un IP scritto nell'indirizzo si risolve da solo.
    #[test]
    fn un_ip_interno_scritto_nell_indirizzo_viene_fermato() {
        for no in [
            "http://127.0.0.1:39100/api/v1/llm-providers",
            "http://192.168.1.1/",
            "http://[::1]:8080/",
            "http://169.254.169.254/latest/meta-data/",
            "http://100.90.1.2:8080/",
        ] {
            let errore = destinazione(no).expect_err(no);
            assert!(
                errore.to_string().contains("indirizzo interno"),
                "{no}: {errore}"
            );
        }
    }

    #[test]
    fn un_ip_pubblico_scritto_nell_indirizzo_passa_e_porta_la_sua_porta() {
        let d = destinazione("https://93.184.216.34/pagina").expect("destinazione");
        assert_eq!(d.host, "93.184.216.34");
        assert_eq!(d.indirizzi[0].port(), 443);
    }
}
