/**
 * known-crawlers-generated.ts — AUTO-GENERATED, do not edit by hand.
 *
 * Synced from monperrus/crawler-user-agents (GitHub, MIT) on 2026-06-02T07:50:03.472Z.
 * Re-run sync: `pnpm --filter @medea/engine-shared sync:bot-list`
 *
 * Purpose: long-tail bot allowlist (oltre i ~70 curati in bot-allowlist.ts).
 * Pattern usati come substring case-insensitive — NO reverse-DNS verify
 * (lista solo per categorizzazione "known crawler"; per anti-spoofing
 * affidabile usa LEGITIMATE_BOTS con suffix DNS).
 */

export interface KnownCrawler {
  /** Pattern UA da matchare (substring case-insensitive). */
  readonly pattern: string;
  /** Data prima aggiunta upstream (ISO YYYY-MM-DD). */
  readonly additionDate: string | null;
  /** Documentazione vendor (se nota). */
  readonly url: string | null;
}

export const KNOWN_CRAWLERS: readonly KnownCrawler[] = Object.freeze([
  {
    pattern: 'Googlebot\\/',
    additionDate: null,
    url: 'http://www.google.com/bot.html',
  },
  {
    pattern: 'Googlebot-Mobile',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'Googlebot-Image',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'Googlebot-News',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'Googlebot-Video',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'AdsBot-Google([^-]|$)',
    additionDate: null,
    url: 'https://support.google.com/webmasters/answer/1061943?hl=en',
  },
  {
    pattern: 'AdsBot-Google-Mobile',
    additionDate: '2017/08/21',
    url: 'https://support.google.com/adwords/answer/2404197',
  },
  {
    pattern: 'Feedfetcher-Google',
    additionDate: '2018/06/27',
    url: 'https://support.google.com/webmasters/answer/178852',
  },
  {
    pattern: 'Mediapartners-Google',
    additionDate: null,
    url: 'https://support.google.com/webmasters/answer/1061943?hl=en',
  },
  {
    pattern: 'Mediapartners \\(Googlebot\\)',
    additionDate: '2017/08/08',
    url: 'https://support.google.com/webmasters/answer/1061943?hl=en',
  },
  {
    pattern: 'APIs-Google',
    additionDate: '2017/08/08',
    url: 'https://support.google.com/webmasters/answer/1061943?hl=en',
  },
  {
    pattern: 'Google-InspectionTool',
    additionDate: null,
    url: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
  },
  {
    pattern: 'Storebot-Google',
    additionDate: null,
    url: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
  },
  {
    pattern: 'GoogleOther',
    additionDate: null,
    url: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
  },
  {
    pattern: 'bingbot',
    additionDate: null,
    url: 'http://www.bing.com/bingbot.htm',
  },
  {
    pattern: 'Slurp',
    additionDate: null,
    url: 'http://help.yahoo.com/help/us/ysearch/slurp',
  },
  {
    pattern: '[wW]get',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'LinkedInBot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'Python-urllib',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'python-requests',
    additionDate: '2018/05/27',
    url: null,
  },
  {
    pattern: 'aiohttp',
    additionDate: '2019/12/23',
    url: 'https://docs.aiohttp.org/en/stable/',
  },
  {
    pattern: 'httpx',
    additionDate: '2019/12/23',
    url: 'https://www.python-httpx.org',
  },
  {
    pattern: 'libwww-perl',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'httpunit',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'Nutch',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'Go-http-client',
    additionDate: '2016/03/26',
    url: 'https://golang.org/pkg/net/http/',
  },
  {
    pattern: 'phpcrawl',
    additionDate: '2012/09/17',
    url: 'http://phpcrawl.cuab.de/',
  },
  {
    pattern: 'msnbot',
    additionDate: null,
    url: 'http://search.msn.com/msnbot.htm',
  },
  {
    pattern: 'jyxobot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'FAST-WebCrawler',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'FAST Enterprise Crawler',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'BIGLOTRON',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'Teoma',
    additionDate: null,
    url: 'http://about.ask.com/en/docs/about/webmasters.shtml',
  },
  {
    pattern: 'convera',
    additionDate: null,
    url: 'http://ews.converasearch.com/crawl.htm',
  },
  {
    pattern: '^Seekbot',
    additionDate: null,
    url: 'http://www.seekbot.net/bot.html',
  },
  {
    pattern: 'Gigabot',
    additionDate: null,
    url: 'http://www.gigablast.com/spider.html',
  },
  {
    pattern: 'Gigablast',
    additionDate: null,
    url: 'https://github.com/gigablast/open-source-search-engine',
  },
  {
    pattern: 'exabot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'ia_archiver',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'GingerCrawler',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'webmon ',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'HTTrack',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'grub\\.org',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'UsineNouvelleCrawler',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'antibot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'netresearchserver',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'speedy',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'fluffy',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'findlink',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'msrbot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'panscient',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'yacybot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'AISearchBot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'ips-agent',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'tagoobot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'MJ12bot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'woriobot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'yanga',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'buzzbot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'mlbot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'yandex\\.com\\/bots',
    additionDate: '2015/04/14',
    url: 'https://yandex.ru/support/webmaster/robot-workings/check-yandex-robots.html#robot-in-logs',
  },
  {
    pattern: 'purebot',
    additionDate: '2010/01/19',
    url: null,
  },
  {
    pattern: 'Linguee Bot',
    additionDate: '2010/01/26',
    url: 'http://www.linguee.com/bot',
  },
  {
    pattern: 'CyberPatrol',
    additionDate: '2010/02/11',
    url: 'http://www.cyberpatrol.com/cyberpatrolcrawler.asp',
  },
  {
    pattern: 'voilabot',
    additionDate: '2010/05/18',
    url: null,
  },
  {
    pattern: 'Baiduspider',
    additionDate: '2010/07/15',
    url: 'http://www.baidu.jp/spider/',
  },
  {
    pattern: 'citeseerxbot',
    additionDate: '2010/07/17',
    url: null,
  },
  {
    pattern: 'spbot',
    additionDate: '2010/07/31',
    url: 'http://www.seoprofiler.com/bot',
  },
  {
    pattern: 'twengabot',
    additionDate: '2010/08/03',
    url: 'http://www.twenga.com/bot.html',
  },
  {
    pattern: 'postrank',
    additionDate: '2010/08/03',
    url: 'http://www.postrank.com',
  },
  {
    pattern: 'Turnitin',
    additionDate: '2010/09/26',
    url: 'http://www.turnitin.com',
  },
  {
    pattern: 'scribdbot',
    additionDate: '2010/09/28',
    url: 'http://www.scribd.com',
  },
  {
    pattern: 'page2rss',
    additionDate: '2010/10/07',
    url: 'http://www.page2rss.com',
  },
  {
    pattern: 'sitebot',
    additionDate: '2010/12/15',
    url: 'http://www.sitebot.org',
  },
  {
    pattern: 'linkdex',
    additionDate: '2011/01/06',
    url: 'http://www.linkdex.com',
  },
  {
    pattern: 'Adidxbot',
    additionDate: null,
    url: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0',
  },
  {
    pattern: 'ezooms',
    additionDate: '2011/04/27',
    url: 'http://www.phpbb.com/community/viewtopic.php?f=64&t=935605&start=450#p12948289',
  },
  {
    pattern: 'dotbot',
    additionDate: '2011/04/27',
    url: null,
  },
  {
    pattern: 'Mail\\.RU_Bot',
    additionDate: '2011/04/27',
    url: null,
  },
  {
    pattern: 'discobot',
    additionDate: '2011/05/03',
    url: 'http://discoveryengine.com/discobot.html',
  },
  {
    pattern: 'heritrix',
    additionDate: '2011/06/21',
    url: 'https://github.com/internetarchive/heritrix3/wiki',
  },
  {
    pattern: 'findthatfile',
    additionDate: '2011/06/21',
    url: 'http://www.findthatfile.com/',
  },
  {
    pattern: 'europarchive\\.org',
    additionDate: '2011/06/21',
    url: '',
  },
  {
    pattern: 'NerdByNature\\.Bot',
    additionDate: '2011/07/12',
    url: 'http://www.nerdbynature.net/bot',
  },
  {
    pattern: '(sistrix|SISTRIX) [cC]rawler',
    additionDate: '2011/08/02',
    url: 'https://www.sistrix.com/tutorials/crawling-errors-in-the-optimizer/',
  },
  {
    pattern: 'Ahrefs(Bot|SiteAudit)',
    additionDate: '2011/08/28',
    url: null,
  },
  {
    pattern: 'fuelbot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: '^CrunchBot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'IndeedBot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'mappydata',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'woobot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'ZoominfoBot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'PrivacyAwareBot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'Multiviewbot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'SWIMGBot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'Grobbot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'eright',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'Apercite',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'semanticbot',
    additionDate: '2018/06/28',
    url: null,
  },
  {
    pattern: 'Aboundex',
    additionDate: '2011/09/28',
    url: 'http://www.aboundex.com/crawler/',
  },
  {
    pattern: 'domaincrawler',
    additionDate: '2011/10/21',
    url: null,
  },
  {
    pattern: 'wbsearchbot',
    additionDate: '2011/12/21',
    url: 'http://www.warebay.com/bot.html',
  },
  {
    pattern: 'summify',
    additionDate: '2012/01/04',
    url: 'http://summify.com',
  },
  {
    pattern: 'CCBot',
    additionDate: '2012/02/05',
    url: 'http://www.commoncrawl.org/bot.html',
  },
  {
    pattern: 'edisterbot',
    additionDate: '2012/02/25',
    url: null,
  },
  {
    pattern: 'SeznamBot',
    additionDate: '2012/03/14',
    url: null,
  },
  {
    pattern: 'ec2linkfinder',
    additionDate: '2012/03/22',
    url: null,
  },
  {
    pattern: 'gslfbot',
    additionDate: '2012/04/03',
    url: null,
  },
  {
    pattern: 'aiHitBot',
    additionDate: '2012/04/16',
    url: null,
  },
  {
    pattern: 'intelium_bot',
    additionDate: '2012/05/07',
    url: null,
  },
  {
    pattern: 'facebookexternalhit',
    additionDate: '2012/05/07',
    url: 'https://developers.facebook.com/docs/sharing/webmasters/crawler/',
  },
  {
    pattern: 'Yeti',
    additionDate: '2012/05/07',
    url: 'http://naver.me/bot',
  },
  {
    pattern: 'RetrevoPageAnalyzer',
    additionDate: '2012/05/07',
    url: null,
  },
  {
    pattern: 'lb-spider',
    additionDate: '2012/05/07',
    url: null,
  },
  {
    pattern: 'Sogou',
    additionDate: '2012/05/13',
    url: 'http://www.sogou.com/docs/help/webmasters.htm#07',
  },
  {
    pattern: 'lssbot',
    additionDate: '2012/05/15',
    url: 'https://www.lssbot.com/',
  },
  {
    pattern: 'careerbot',
    additionDate: '2012/05/23',
    url: 'http://www.career-x.de/bot.html',
  },
  {
    pattern: 'wotbox',
    additionDate: '2012/06/12',
    url: 'http://www.wotbox.com',
  },
  {
    pattern: 'wocbot',
    additionDate: '2012/07/25',
    url: 'http://www.wocodi.com/crawler',
  },
  {
    pattern: 'ichiro',
    additionDate: '2012/08/28',
    url: 'http://help.goo.ne.jp/help/article/1142',
  },
  {
    pattern: 'DuckDuckBot',
    additionDate: '2012/09/19',
    url: 'http://duckduckgo.com/duckduckbot.html',
  },
  {
    pattern: 'lssrocketcrawler',
    additionDate: '2012/09/24',
    url: null,
  },
  {
    pattern: 'drupact',
    additionDate: '2012/09/27',
    url: 'http://www.arocom.de/drupact',
  },
  {
    pattern: 'webcompanycrawler',
    additionDate: '2012/10/03',
    url: null,
  },
  {
    pattern: 'acoonbot',
    additionDate: '2012/10/07',
    url: 'http://www.acoon.de/robot.asp',
  },
  {
    pattern: 'openindexspider',
    additionDate: '2012/10/26',
    url: 'http://www.openindex.io/en/webmasters/spider.html',
  },
  {
    pattern: 'gnam gnam spider',
    additionDate: '2012/10/31',
    url: null,
  },
  {
    pattern: 'web-archive-net\\.com\\.bot',
    additionDate: null,
    url: null,
  },
  {
    pattern: 'backlinkcrawler',
    additionDate: '2013/01/04',
    url: 'http://www.backlinktest.com/crawler.html',
  },
  {
    pattern: 'coccoc',
    additionDate: '2013/01/04',
    url: 'http://help.coccoc.vn/',
  },
  {
    pattern: 'integromedb',
    additionDate: '2013/01/10',
    url: 'http://www.integromedb.org/Crawler',
  },
  {
    pattern: 'content crawler spider',
    additionDate: '2013/01/11',
    url: null,
  },
  {
    pattern: 'toplistbot',
    additionDate: '2013/02/05',
    url: null,
  },
  {
    pattern: 'it2media-domain-crawler',
    additionDate: '2013/03/12',
    url: null,
  },
  {
    pattern: 'ip-web-crawler\\.com',
    additionDate: '2013/03/22',
    url: null,
  },
  {
    pattern: 'siteexplorer\\.info',
    additionDate: '2013/05/01',
    url: null,
  },
  {
    pattern: 'elisabot',
    additionDate: '2013/06/27',
    url: null,
  },
  {
    pattern: 'proximic',
    additionDate: '2013/09/12',
    url: 'http://www.proximic.com/info/spider.php',
  },
  {
    pattern: 'changedetection',
    additionDate: '2013/09/13',
    url: 'http://www.changedetection.com/bot.html',
  },
  {
    pattern: 'arabot',
    additionDate: '2013/10/09',
    url: null,
  },
  {
    pattern: 'WeSEE:Search',
    additionDate: '2013/11/18',
    url: null,
  },
  {
    pattern: 'niki-bot',
    additionDate: '2014/01/01',
    url: null,
  },
  {
    pattern: 'CrystalSemanticsBot',
    additionDate: '2014/02/17',
    url: 'http://www.crystalsemantics.com/user-agent/',
  },
  {
    pattern: 'rogerbot',
    additionDate: '2014/02/28',
    url: 'http://moz.com/help/pro/what-is-rogerbot-',
  },
  {
    pattern: '360Spider',
    additionDate: '2014/03/14',
    url: 'http://needs-be.blogspot.co.uk/2013/02/how-to-block-spider360.html',
  },
  {
    pattern: 'psbot',
    additionDate: '2014/03/31',
    url: 'http://www.picsearch.com/bot.html',
  },
  {
    pattern: 'InterfaxScanBot',
    additionDate: '2014/03/31',
    url: 'http://scan-interfax.ru',
  },
  {
    pattern: 'CC Metadata Scaper',
    additionDate: '2014/04/01',
    url: 'http://wiki.creativecommons.org/Metadata_Scraper',
  },
  {
    pattern: 'g00g1e\\.net',
    additionDate: '2014/04/01',
    url: 'http://www.g00g1e.net/',
  },
  {
    pattern: 'GrapeshotCrawler',
    additionDate: '2014/04/01',
    url: 'http://www.grapeshot.co.uk/crawler.php',
  },
  {
    pattern: 'urlappendbot',
    additionDate: '2014/05/10',
    url: 'http://www.profound.net/urlappendbot.html',
  },
  {
    pattern: 'brainobot',
    additionDate: '2014/06/24',
    url: null,
  },
  {
    pattern: 'fr-crawler',
    additionDate: '2014/07/31',
    url: null,
  },
  {
    pattern: 'binlar',
    additionDate: '2014/09/12',
    url: null,
  },
  {
    pattern: 'SimpleCrawler',
    additionDate: '2014/09/12',
    url: null,
  },
  {
    pattern: 'Twitterbot',
    additionDate: '2014/09/12',
    url: 'https://dev.twitter.com/cards/getting-started',
  },
  {
    pattern: 'cXensebot',
    additionDate: '2014/10/05',
    url: 'http://www.cxense.com/bot.html',
  },
  {
    pattern: 'smtbot',
    additionDate: '2014/10/04',
    url: 'http://www.similartech.com/smtbot',
  },
  {
    pattern: 'bnf\\.fr_bot',
    additionDate: '2014/11/18',
    url: 'http://www.bnf.fr/fr/outils/a.dl_web_capture_robot.html',
  },
  {
    pattern: 'A6-Indexer',
    additionDate: '2014/12/05',
    url: 'http://www.a6corp.com/a6-web-scraping-policy/',
  },
  {
    pattern: 'ADmantX',
    additionDate: '2014/12/05',
    url: 'http://www.admantx.com',
  },
  {
    pattern: 'Facebot',
    additionDate: '2014/12/30',
    url: 'https://developers.facebook.com/docs/sharing/best-practices#crawl',
  },
  {
    pattern: 'OrangeBot\\/',
    additionDate: '2015/01/12',
    url: null,
  },
  {
    pattern: 'memorybot',
    additionDate: '2015/02/01',
    url: 'http://mignify.com/bot.htm',
  },
  {
    pattern: 'AdvBot',
    additionDate: '2015/02/01',
    url: 'http://advbot.net/bot.html',
  },
  {
    pattern: 'MegaIndex',
    additionDate: '2015/03/28',
    url: 'https://www.megaindex.ru/?tab=linkAnalyze',
  },
  {
    pattern: 'SemanticScholarBot',
    additionDate: '2015/03/28',
    url: 'https://www.semanticscholar.org/crawler',
  },
  {
    pattern: 'ltx71',
    additionDate: '2015/04/04',
    url: 'http://ltx71.com/',
  },
  {
    pattern: 'nerdybot',
    additionDate: '2015/04/05',
    url: 'http://nerdybot.com/',
  },
  {
    pattern: 'xovibot',
    additionDate: '2015/04/05',
    url: 'http://www.xovibot.net/',
  },
  {
    pattern: 'BUbiNG',
    additionDate: '2015/04/06',
    url: 'http://law.di.unimi.it/BUbiNG.html',
  },
  {
    pattern: 'Qwantify',
    additionDate: '2015/04/06',
    url: 'https://www.qwant.com/',
  },
  {
    pattern: 'archive\\.org_bot',
    additionDate: '2015/04/14',
    url: 'http://www.archive.org/details/archive.org_bot',
  },
  {
    pattern: 'Applebot',
    additionDate: '2015/04/15',
    url: 'http://www.apple.com/go/applebot',
  },
  {
    pattern: 'TweetmemeBot',
    additionDate: '2015/04/15',
    url: 'http://datasift.com/bot.html',
  },
  {
    pattern: 'crawler4j',
    additionDate: '2015/05/07',
    url: 'https://github.com/yasserg/crawler4j',
  },
  {
    pattern: 'findxbot',
    additionDate: '2015/05/07',
    url: 'http://www.findxbot.com',
  },
  {
    pattern: 'S[eE][mM]rushBot',
    additionDate: '2015/05/26',
    url: 'http://www.semrush.com/bot.html',
  },
  {
    pattern: 'yoozBot',
    additionDate: '2015/05/26',
    url: 'http://yooz.ir',
  },
  {
    pattern: 'lipperhey',
    additionDate: '2015/08/26',
    url: 'http://www.lipperhey.com/',
  },
  {
    pattern: 'Y!J',
    additionDate: '2015/05/26',
    url: 'https://www.yahoo-help.jp/app/answers/detail/p/595/a_id/42716/~/%E3%82%A6%E3%82%A7%E3%83%96%E3%83%9A%E3%83%BC%E3%82%B8%E3%81%AB%E3%82%A2%E3%82%AF%E3%82%BB%E3%82%B9%E3%81%99%E3%82%8B%E3%82%B7%E3%82%B9%E3%83%86%E3%83%A0%E3%81%AE%E3%83%A6%E3%83%BC%E3%82%B6%E3%83%BC%E3%82%A8%E3%83%BC%E3%82%B8%E3%82%A7%E3%83%B3%E3%83%88%E3%81%AB%E3%81%A4%E3%81%84%E3%81%A6',
  },
  {
    pattern: 'Domain Re-Animator Bot',
    additionDate: '2015/04/14',
    url: 'http://domainreanimator.com',
  },
  {
    pattern: 'AddThis',
    additionDate: '2015/06/02',
    url: 'https://www.addthis.com',
  },
  {
    pattern: 'Screaming Frog SEO Spider',
    additionDate: '2016/01/08',
    url: 'http://www.screamingfrog.co.uk/seo-spider',
  },
  {
    pattern: 'MetaURI',
    additionDate: '2016/01/02',
    url: 'http://www.useragentstring.com/MetaURI_id_17683.php',
  },
  {
    pattern: 'Scrapy',
    additionDate: '2016/01/02',
    url: 'http://scrapy.org/',
  },
  {
    pattern: 'Livelap[bB]ot',
    additionDate: '2016/01/02',
    url: 'http://site.livelap.com/crawler',
  },
  {
    pattern: 'OpenHoseBot',
    additionDate: '2016/01/02',
    url: 'http://www.openhose.org/bot.html',
  },
  {
    pattern: 'CapsuleChecker',
    additionDate: '2016/01/02',
    url: 'http://www.capsulink.com/about',
  },
  {
    pattern: 'collection@infegy\\.com',
    additionDate: '2016/01/03',
    url: 'http://infegy.com/',
  },
  {
    pattern: 'IstellaBot',
    additionDate: '2016/01/09',
    url: 'http://www.tiscali.it/',
  },
  {
    pattern: 'DeuSu\\/',
    additionDate: '2016/01/23',
    url: 'https://deusu.de/robot.html',
  },
  {
    pattern: 'betaBot',
    additionDate: '2016/01/23',
    url: null,
  },
  {
    pattern: 'Cliqzbot\\/',
    additionDate: '2016/01/23',
    url: 'http://cliqz.com/company/cliqzbot',
  },
  {
    pattern: 'MojeekBot\\/',
    additionDate: '2016/01/23',
    url: 'https://www.mojeek.com/bot.html',
  },
  {
    pattern: 'netEstate NE Crawler',
    additionDate: '2016/01/23',
    url: 'http://www.website-datenbank.de/',
  },
  {
    pattern: 'SafeSearch microdata crawler',
    additionDate: '2016/01/23',
    url: 'https://safesearch.avira.com',
  },
  {
    pattern: 'Gluten Free Crawler\\/',
    additionDate: '2016/01/23',
    url: 'http://glutenfreepleasure.com/',
  },
  {
    pattern: 'Sonic',
    additionDate: '2016/02/08',
    url: 'http://www.yama.info.waseda.ac.jp/~crawler/info.html',
  },
  {
    pattern: 'Sysomos',
    additionDate: '2016/02/08',
    url: 'http://www.sysomos.com',
  },
  {
    pattern: 'Trove',
    additionDate: '2016/02/08',
    url: 'http://www.trove.com',
  },
  {
    pattern: 'deadlinkchecker',
    additionDate: '2016/02/08',
    url: 'http://www.deadlinkchecker.com',
  },
  {
    pattern: 'Slack-ImgProxy',
    additionDate: '2016/04/25',
    url: 'https://api.slack.com/robots',
  },
  {
    pattern: 'Embedly',
    additionDate: '2016/04/25',
    url: 'http://support.embed.ly',
  },
  {
    pattern: 'RankActiveLinkBot',
    additionDate: '2016/06/20',
    url: 'https://rankactive.com/resources/rankactive-linkbot',
  },
  {
    pattern: 'iskanie',
    additionDate: '2016/09/02',
    url: 'http://www.iskanie.com',
  },
  {
    pattern: 'SafeDNSBot',
    additionDate: '2016/09/10',
    url: 'https://www.safedns.com/searchbot',
  },
  {
    pattern: 'SkypeUriPreview',
    additionDate: '2016/10/10',
    url: null,
  },
  {
    pattern: 'Veoozbot',
    additionDate: '2016/11/03',
    url: 'http://www.veooz.com/veoozbot.html',
  },
  {
    pattern: 'Slackbot',
    additionDate: '2016/11/03',
    url: 'https://api.slack.com/robots',
  },
  {
    pattern: 'redditbot',
    additionDate: '2016/11/03',
    url: 'http://www.reddit.com/feedback',
  },
  {
    pattern: 'datagnionbot',
    additionDate: '2016/11/03',
    url: 'http://www.datagnion.com/bot.html',
  },
  {
    pattern: 'Google-Adwords-Instant',
    additionDate: '2016/11/03',
    url: 'http://www.google.com/adsbot.html',
  },
  {
    pattern: 'adbeat_bot',
    additionDate: '2016/11/04',
    url: null,
  },
  {
    pattern: 'WhatsApp',
    additionDate: '2016/11/15',
    url: 'https://www.whatsapp.com/',
  },
  {
    pattern: 'contxbot',
    additionDate: '2017/02/25',
    url: null,
  },
  {
    pattern: 'pinterest\\.com\\/bot',
    additionDate: '2017/03/03',
    url: 'http://www.pinterest.com/bot.html',
  },
  {
    pattern: 'electricmonk',
    additionDate: '2017/03/04',
    url: 'https://www.duedil.com/our-crawler/',
  },
  {
    pattern: 'GarlikCrawler',
    additionDate: '2017/03/18',
    url: 'http://garlik.com/',
  },
  {
    pattern: 'BingPreview\\/',
    additionDate: '2017/04/23',
    url: 'https://www.bing.com/webmaster/help/which-crawlers-does-bing-use-8c184ec0',
  },
  {
    pattern: 'vebidoobot',
    additionDate: '2017/05/08',
    url: 'https://blog.vebidoo.de/vebidoobot/',
  },
  {
    pattern: 'FemtosearchBot',
    additionDate: '2017/05/16',
    url: 'http://femtosearch.com',
  },
  {
    pattern: 'Yahoo Link Preview',
    additionDate: '2017/06/28',
    url: 'https://help.yahoo.com/kb/mail/yahoo-link-preview-SLN23615.html',
  },
  {
    pattern: 'MetaJobBot',
    additionDate: '2017/08/16',
    url: 'http://www.metajob.de/the/crawler',
  },
  {
    pattern: 'DomainStatsBot',
    additionDate: '2017/08/16',
    url: 'http://domainstats.io/our-bot',
  },
  {
    pattern: 'mindUpBot',
    additionDate: '2017/08/16',
    url: 'http://www.datenbutler.de/',
  },
  {
    pattern: 'Daum\\/',
    additionDate: '2017/08/16',
    url: 'http://cs.daum.net/faq/15/4118.html?faqId=28966',
  },
  {
    pattern: 'Jugendschutzprogramm-Crawler',
    additionDate: '2017/08/16',
    url: 'http://www.jugendschutzprogramm.de',
  },
  {
    pattern: 'Xenu Link Sleuth',
    additionDate: '2017/08/19',
    url: 'http://home.snafu.de/tilman/xenulink.html',
  },
  {
    pattern: 'Pcore-HTTP',
    additionDate: '2017/08/19',
    url: 'https://bitbucket.org/softvisio/pcore/overview',
  },
  {
    pattern: 'moatbot',
    additionDate: '2017/09/16',
    url: 'https://moat.com',
  },
  {
    pattern: 'KosmioBot',
    additionDate: '2017/09/16',
    url: 'http://kosm.io/bot.html',
  },
  {
    pattern: '[pP]ingdom',
    additionDate: '2017/09/16',
    url: 'http://www.pingdom.com',
  },
  {
    pattern: 'AppInsights',
    additionDate: '2019/03/09',
    url: 'https://docs.microsoft.com/en-us/azure/azure-monitor/app/app-insights-overview',
  },
  {
    pattern: 'PhantomJS',
    additionDate: '2017/09/18',
    url: 'http://phantomjs.org/',
  },
  {
    pattern: 'Gowikibot',
    additionDate: '2017/10/26',
    url: 'http://www.gowikibot.com',
  },
  {
    pattern: 'PiplBot',
    additionDate: '2017/10/30',
    url: 'http://www.pipl.com/bot/',
  },
  {
    pattern: 'Discordbot',
    additionDate: '2017/09/22',
    url: 'https://discordapp.com',
  },
  {
    pattern: 'TelegramBot',
    additionDate: '2017/10/01',
    url: null,
  },
  {
    pattern: 'Jetslide',
    additionDate: '2017/09/27',
    url: 'http://jetsli.de/crawler',
  },
  {
    pattern: 'newsharecounts',
    additionDate: '2017/09/30',
    url: 'http://newsharecounts.com/crawler',
  },
  {
    pattern: 'James BOT',
    additionDate: '2017/10/12',
    url: 'http://cognitiveseo.com/bot.html',
  },
  {
    pattern: 'Bark[rR]owler',
    additionDate: '2017/10/09',
    url: 'http://www.exensa.com/crawl',
  },
  {
    pattern: 'TinEye',
    additionDate: '2017/10/14',
    url: 'http://www.tineye.com/crawler.html',
  },
  {
    pattern: 'SocialRankIOBot',
    additionDate: '2017/10/19',
    url: 'http://socialrank.io/about',
  },
  {
    pattern: 'trendictionbot',
    additionDate: '2017/10/30',
    url: 'http://www.trendiction.de/bot',
  },
  {
    pattern: 'Ocarinabot',
    additionDate: '2017/09/27',
    url: null,
  },
  {
    pattern: 'epicbot',
    additionDate: '2017/10/31',
    url: 'http://www.epictions.com/epicbot',
  },
  {
    pattern: 'Primalbot',
    additionDate: '2017/09/27',
    url: 'https://www.primal.com',
  },
  {
    pattern: 'DuckDuckGo-Favicons-Bot',
    additionDate: '2017/10/06',
    url: 'http://duckduckgo.com',
  },
  {
    pattern: 'GnowitNewsbot',
    additionDate: '2017/10/30',
    url: 'http://www.gnowit.com',
  },
  {
    pattern: 'Leikibot',
    additionDate: '2017/09/24',
    url: 'http://www.leiki.com',
  },
  {
    pattern: 'LinkArchiver',
    additionDate: '2017/09/24',
    url: 'https://github.com/thisisparker/linkarchiver',
  },
  {
    pattern: 'YaK\\/',
    additionDate: '2017/09/25',
    url: 'http://linkfluence.com',
  },
  {
    pattern: 'PaperLiBot',
    additionDate: '2017/09/25',
    url: 'http://support.paper.li/entries/20023257-what-is-paper-li',
  },
  {
    pattern: 'Digg Deeper',
    additionDate: '2017/09/26',
    url: 'http://digg.com/about',
  },
  {
    pattern: '^dcrawl',
    additionDate: '2017/09/22',
    url: 'https://github.com/kgretzky/dcrawl',
  },
  {
    pattern: 'Snacktory',
    additionDate: '2017/09/23',
    url: 'https://github.com/karussell/snacktory',
  },
  {
    pattern: 'AndersPinkBot',
    additionDate: '2017/09/24',
    url: 'http://anderspink.com/bot.html',
  },
  {
    pattern: 'Fyrebot',
    additionDate: '2017/09/22',
    url: null,
  },
  {
    pattern: 'EveryoneSocialBot',
    additionDate: '2017/09/22',
    url: 'http://everyonesocial.com',
  },
  {
    pattern: 'Mediatoolkitbot',
    additionDate: '2017/10/06',
    url: 'http://mediatoolkit.com',
  },
  {
    pattern: 'Luminator-robots',
    additionDate: '2017/09/22',
    url: null,
  },
  {
    pattern: 'ExtLinksBot',
    additionDate: '2017/11/02',
    url: 'https://extlinks.com/Bot.html',
  },
  {
    pattern: 'SurveyBot',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'NING\\/',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'okhttp',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'Nuzzel',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'omgili',
    additionDate: '2017/11/02',
    url: 'http://omgili.com',
  },
  {
    pattern: 'PocketParser',
    additionDate: '2017/11/02',
    url: 'https://getpocket.com/pocketparser_ua',
  },
  {
    pattern: 'YisouSpider',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'um-LN',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'ToutiaoSpider',
    additionDate: '2017/11/02',
    url: 'http://web.toutiao.com/media_cooperation/',
  },
  {
    pattern: 'MuckRack',
    additionDate: '2017/11/02',
    url: 'http://muckrack.com',
  },
  {
    pattern: "Jamie's Spider",
    additionDate: '2017/11/02',
    url: 'http://jamiembrown.com/',
  },
  {
    pattern: 'AHC\\/',
    additionDate: '2017/11/02',
    url: 'https://github.com/AsyncHttpClient/async-http-client',
  },
  {
    pattern: 'NetcraftSurveyAgent',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'Laserlikebot',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: '^Apache-HttpClient',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'AppEngine-Google',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'Jetty',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'Upflow',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'Thinklab',
    additionDate: '2017/11/02',
    url: 'thinklab.com',
  },
  {
    pattern: 'Traackr\\.com',
    additionDate: '2017/11/02',
    url: 'https://www.traackr.com/',
  },
  {
    pattern: 'Twurly',
    additionDate: '2017/11/02',
    url: 'http://twurly.org',
  },
  {
    pattern: 'Mastodon',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'http_get',
    additionDate: '2017/11/02',
    url: null,
  },
  {
    pattern: 'DnyzBot',
    additionDate: '2017/11/20',
    url: null,
  },
  {
    pattern: 'botify',
    additionDate: '2018/02/01',
    url: null,
  },
  {
    pattern: '007ac9 Crawler',
    additionDate: '2018/02/09',
    url: null,
  },
  {
    pattern: 'BehloolBot',
    additionDate: '2018/02/09',
    url: null,
  },
  {
    pattern: 'BrandVerity',
    additionDate: '2018/02/27',
    url: 'http://www.brandverity.com/why-is-brandverity-visiting-me',
  },
  {
    pattern: 'check_http',
    additionDate: '2018/02/09',
    url: null,
  },
  {
    pattern: 'BDCbot',
    additionDate: '2018/02/09',
    url: null,
  },
  {
    pattern: 'ZumBot',
    additionDate: '2018/02/09',
    url: null,
  },
  {
    pattern: 'EZID',
    additionDate: '2018/02/09',
    url: null,
  },
  {
    pattern: 'ICC-Crawler',
    additionDate: '2018/02/28',
    url: 'http://ucri.nict.go.jp/en/icccrawler.html',
  },
  {
    pattern: 'ArchiveBot',
    additionDate: '2018/02/28',
    url: 'https://github.com/ArchiveTeam/ArchiveBot',
  },
  {
    pattern: '^LCC ',
    additionDate: '2018/02/28',
    url: 'http://corpora.informatik.uni-leipzig.de/crawler_faq.html',
  },
  {
    pattern: 'filterdb\\.iss\\.net\\/crawler',
    additionDate: '2018/03/16',
    url: 'http://filterdb.iss.net/crawler/',
  },
  {
    pattern: 'BLP_bbot',
    additionDate: '2018/03/27',
    url: null,
  },
  {
    pattern: 'BomboraBot',
    additionDate: '2018/03/27',
    url: 'http://www.bombora.com/bot',
  },
  {
    pattern: 'Buck\\/',
    additionDate: '2018/03/27',
    url: 'https://app.hypefactors.com/media-monitoring/about.html',
  },
  {
    pattern: 'Companybook-Crawler',
    additionDate: '2018/03/27',
    url: 'https://www.companybooknetworking.com/',
  },
  {
    pattern: 'Genieo',
    additionDate: '2018/03/27',
    url: 'http://www.genieo.com/webfilter.html',
  },
  {
    pattern: 'magpie-crawler',
    additionDate: '2018/03/27',
    url: 'http://www.brandwatch.net',
  },
  {
    pattern: 'MeltwaterNews',
    additionDate: '2018/03/27',
    url: 'http://www.meltwater.com',
  },
  {
    pattern: 'Moreover',
    additionDate: '2018/03/27',
    url: 'http://www.moreover.com',
  },
  {
    pattern: 'newspaper\\/',
    additionDate: '2018/03/27',
    url: null,
  },
  {
    pattern: 'ScoutJet',
    additionDate: '2018/03/27',
    url: 'http://www.scoutjet.com/',
  },
  {
    pattern: '(^| )sentry\\/',
    additionDate: '2018/03/27',
    url: 'https://sentry.io',
  },
  {
    pattern: 'StorygizeBot',
    additionDate: '2018/03/27',
    url: 'http://www.storygize.com',
  },
  {
    pattern: 'UptimeRobot',
    additionDate: '2018/03/27',
    url: 'http://www.uptimerobot.com/',
  },
  {
    pattern: 'OutclicksBot',
    additionDate: '2018/04/21',
    url: 'https://www.outclicks.net',
  },
  {
    pattern: 'seoscanners',
    additionDate: '2018/05/27',
    url: 'https://github.com/monperrus/crawler-user-agents/issues/384#issuecomment-2575367162',
  },
  {
    pattern: 'Hatena',
    additionDate: '2018/05/29',
    url: null,
  },
  {
    pattern: 'Google Web Preview',
    additionDate: '2018/05/31',
    url: null,
  },
  {
    pattern: 'MauiBot',
    additionDate: '2018/06/06',
    url: null,
  },
  {
    pattern: 'AlphaBot',
    additionDate: '2018/05/27',
    url: 'http://alphaseobot.com/bot.html',
  },
  {
    pattern: 'SBL-BOT',
    additionDate: '2018/06/06',
    url: 'http://sbl.net',
  },
  {
    pattern: 'IAS crawler',
    additionDate: '2018/06/06',
    url: 'http://integralads.com/site-indexing-policy/',
  },
  {
    pattern: 'adscanner',
    additionDate: '2018/06/24',
    url: null,
  },
  {
    pattern: 'Netvibes',
    additionDate: '2018/06/24',
    url: 'http://www.netvibes.com',
  },
  {
    pattern: 'acapbot',
    additionDate: '2018/06/27',
    url: null,
  },
  {
    pattern: 'Baidu-YunGuanCe',
    additionDate: '2018/06/27',
    url: 'https://ce.baidu.com/topic/topic20150908',
  },
  {
    pattern: 'bitlybot',
    additionDate: '2018/06/27',
    url: 'http://bit.ly/',
  },
  {
    pattern: 'blogmuraBot',
    additionDate: '2018/06/27',
    url: 'http://www.blogmura.com',
  },
  {
    pattern: 'Bot\\.AraTurka\\.com',
    additionDate: '2018/06/27',
    url: 'http://www.araturka.com',
  },
  {
    pattern: 'bot-pge\\.chlooe\\.com',
    additionDate: '2018/06/27',
    url: null,
  },
  {
    pattern: 'BoxcarBot',
    additionDate: '2018/06/27',
    url: 'https://boxcar.io/',
  },
  {
    pattern: 'BTWebClient',
    additionDate: '2018/06/27',
    url: 'http://www.utorrent.com/',
  },
  {
    pattern: 'ContextAd Bot',
    additionDate: '2018/06/27',
    url: null,
  },
  {
    pattern: 'Digincore bot',
    additionDate: '2018/06/27',
    url: 'http://www.digincore.com/crawler.html',
  },
  {
    pattern: 'Disqus',
    additionDate: '2018/06/27',
    url: 'https://disqus.com/',
  },
  {
    pattern: 'Feedly',
    additionDate: '2018/06/27',
    url: 'https://www.feedly.com/fetcher.html',
  },
  {
    pattern: 'Fetch\\/',
    additionDate: '2018/06/27',
    url: null,
  },
  {
    pattern: 'Fever',
    additionDate: '2018/06/27',
    url: 'http://feedafever.com',
  },
  {
    pattern: 'Flamingo_SearchEngine',
    additionDate: '2018/06/27',
    url: null,
  },
  {
    pattern: 'FlipboardProxy',
    additionDate: '2018/06/27',
    url: 'https://about.flipboard.com/browserproxy/',
  },
  {
    pattern: 'g2reader-bot',
    additionDate: '2018/06/27',
    url: 'http://www.g2reader.com/',
  },
  {
    pattern: 'G2 Web Services',
    additionDate: '2019/03/01',
    url: 'https://www.g2webservices.com/',
  },
  {
    pattern: 'imrbot',
    additionDate: '2018/06/27',
    url: 'http://www.mignify.com',
  },
  {
    pattern: 'K7MLWCBot',
    additionDate: '2018/06/27',
    url: 'http://www.k7computing.com',
  },
  {
    pattern: 'Kemvibot',
    additionDate: '2018/06/27',
    url: 'http://kemvi.com',
  },
  {
    pattern: 'Landau-Media-Spider',
    additionDate: '2018/06/27',
    url: 'http://bots.landaumedia.de/bot.html',
  },
  {
    pattern: 'linkapediabot',
    additionDate: '2018/06/27',
    url: 'http://www.linkapedia.com',
  },
  {
    pattern: 'vkShare',
    additionDate: '2018/07/02',
    url: 'http://vk.com/dev/Share',
  },
  {
    pattern: 'Siteimprove\\.com',
    additionDate: '2018/06/22',
    url: null,
  },
  {
    pattern: 'BLEXBot\\/',
    additionDate: '2018/07/07',
    url: 'http://webmeup-crawler.com',
  },
  {
    pattern: 'DareBoost',
    additionDate: '2018/07/07',
    url: 'https://www.dareboost.com/',
  },
  {
    pattern: 'ZuperlistBot\\/',
    additionDate: '2018/07/07',
    url: null,
  },
  {
    pattern: 'Miniflux\\/',
    additionDate: '2018/07/07',
    url: 'https://miniflux.net',
  },
  {
    pattern: 'Feedspot',
    additionDate: '2018/07/07',
    url: 'http://www.feedspot.com/fs/bot',
  },
  {
    pattern: 'Diffbot\\/',
    additionDate: '2018/07/07',
    url: 'http://www.diffbot.com',
  },
  {
    pattern: 'SEOkicks',
    additionDate: '2018/08/22',
    url: 'https://www.seokicks.de/robot.html',
  },
  {
    pattern: 'tracemyfile',
    additionDate: '2018/08/23',
    url: null,
  },
  {
    pattern: 'Nimbostratus-Bot',
    additionDate: '2018/08/29',
    url: null,
  },
  {
    pattern: 'zgrab',
    additionDate: '2018/08/30',
    url: 'https://github.com/zmap/zgrab2',
  },
  {
    pattern: 'PR-CY\\.RU',
    additionDate: '2018/08/30',
    url: 'https://a.pr-cy.ru/',
  },
  {
    pattern: 'AdsTxtCrawler',
    additionDate: '2018/08/30',
    url: null,
  },
  {
    pattern: 'Datafeedwatch',
    additionDate: '2018/09/05',
    url: 'https://www.datafeedwatch.com/',
  },
  {
    pattern: 'Zabbix',
    additionDate: '2018/09/05',
    url: 'https://www.zabbix.com/documentation/3.4/manual/web_monitoring',
  },
  {
    pattern: 'TangibleeBot',
    additionDate: '2018/09/05',
    url: 'http://tangiblee.com/bot',
  },
  {
    pattern: 'google-xrawler',
    additionDate: '2018/09/05',
    url: 'https://webmasters.stackexchange.com/questions/105560/what-is-the-google-xrawler-user-agent-used-for',
  },
  {
    pattern: 'axios',
    additionDate: '2018/09/06',
    url: 'https://github.com/axios/axios',
  },
  {
    pattern: 'Amazon CloudFront',
    additionDate: '2018/09/07',
    url: 'https://aws.amazon.com/cloudfront/',
  },
  {
    pattern: 'Pulsepoint ',
    additionDate: '2018/09/24',
    url: null,
  },
  {
    pattern: 'CloudFlare-AlwaysOnline',
    additionDate: '2018/09/27',
    url: 'https://www.cloudflare.com/always-online/',
  },
  {
    pattern: 'Cloudflare-Healthchecks',
    additionDate: '2024/12/17',
    url: 'https://developers.cloudflare.com/health-checks/',
  },
  {
    pattern: 'Cloudflare-Traffic-Manager',
    additionDate: '2024/12/17',
    url: 'https://developers.cloudflare.com/load-balancing/monitors/',
  },
  {
    pattern: 'CloudFlare-Prefetch',
    additionDate: '2024/12/17',
    url: 'https://developers.cloudflare.com/speed/optimization/content/prefetch-urls/',
  },
  {
    pattern: 'Cloudflare-SSLDetector',
    additionDate: '2024/12/17',
    url: 'https://developers.cloudflare.com/ssl/origin-configuration/ssl-tls-recommender/',
  },
  {
    pattern: 'https:\\/\\/developers\\.cloudflare\\.com\\/security-center\\/',
    additionDate: '2024/12/17',
    url: 'https://developers.cloudflare.com/ssl/origin-configuration/ssl-tls-recommender/',
  },
  {
    pattern: 'Google-Structured-Data-Testing-Tool',
    additionDate: '2018/10/02',
    url: 'https://search.google.com/structured-data/testing-tool',
  },
  {
    pattern: 'WordupInfoSearch',
    additionDate: '2018/10/07',
    url: null,
  },
  {
    pattern: 'WebDataStats',
    additionDate: '2018/10/08',
    url: 'https://webdatastats.com/',
  },
  {
    pattern: 'HttpUrlConnection',
    additionDate: '2018/10/08',
    url: null,
  },
  {
    pattern: 'ZoomBot',
    additionDate: '2018/10/10',
    url: 'http://suite.seozoom.it/bot.html',
  },
  {
    pattern: 'VelenPublicWebCrawler',
    additionDate: '2018/10/09',
    url: 'https://velen.io/',
  },
  {
    pattern: 'MoodleBot',
    additionDate: '2018/10/10',
    url: null,
  },
  {
    pattern: 'jpg-newsbot',
    additionDate: '2018/10/10',
    url: 'https://vipnytt.no/bots/',
  },
  {
    pattern: 'outbrain',
    additionDate: '2018/10/14',
    url: 'https://www.outbrain.com/help/advertisers/invalid-url/',
  },
  {
    pattern: 'W3C_Validator',
    additionDate: '2018/10/14',
    url: 'https://validator.w3.org/services',
  },
  {
    pattern: 'Validator\\.nu',
    additionDate: '2018/10/14',
    url: 'https://validator.w3.org/services',
  },
  {
    pattern: 'W3C-checklink',
    additionDate: '2018/10/14',
    url: 'https://validator.w3.org/services',
  },
  {
    pattern: 'W3C-mobileOK',
    additionDate: '2018/10/14',
    url: 'https://validator.w3.org/services',
  },
  {
    pattern: 'W3C_I18n-Checker',
    additionDate: '2018/10/14',
    url: 'https://validator.w3.org/services',
  },
  {
    pattern: 'FeedValidator',
    additionDate: '2018/10/14',
    url: 'https://validator.w3.org/services',
  },
  {
    pattern: 'W3C_CSS_Validator',
    additionDate: '2018/10/14',
    url: 'https://validator.w3.org/services',
  },
  {
    pattern: 'W3C_Unicorn',
    additionDate: '2018/10/14',
    url: 'https://validator.w3.org/services',
  },
  {
    pattern: 'Google-PhysicalWeb',
    additionDate: '2018/10/21',
    url: null,
  },
  {
    pattern: 'Blackboard',
    additionDate: '2018/10/28',
    url: 'https://help.blackboard.com/Learn/Administrator/Hosting/Tools_Management/SafeAssign',
  },
  {
    pattern: 'ICBot\\/',
    additionDate: '2018/10/23',
    url: 'https://ideasandcode.xyz',
  },
  {
    pattern: 'BazQux',
    additionDate: '2018/10/23',
    url: 'https://bazqux.com/fetcher',
  },
  {
    pattern: 'Twingly',
    additionDate: '2018/10/23',
    url: 'https://twingly.com',
  },
  {
    pattern: 'Rivva',
    additionDate: '2018/10/23',
    url: 'http://rivva.de',
  },
  {
    pattern: 'Experibot',
    additionDate: '2018/11/03',
    url: 'https://amirkr.wixsite.com/experibot',
  },
  {
    pattern: 'awesomecrawler',
    additionDate: '2018/11/24',
    url: null,
  },
  {
    pattern: 'Dataprovider\\.com',
    additionDate: '2018/11/24',
    url: 'https://www.dataprovider.com/',
  },
  {
    pattern: 'GroupHigh\\/',
    additionDate: '2018/11/24',
    url: 'http://www.grouphigh.com/',
  },
  {
    pattern: 'theoldreader\\.com',
    additionDate: '2018/12/02',
    url: 'https://www.theoldreader.com/',
  },
  {
    pattern: 'AnyEvent',
    additionDate: '2018/12/07',
    url: 'http://software.schmorp.de/pkg/AnyEvent.html',
  },
  {
    pattern: 'Uptimebot\\.org',
    additionDate: '2019/01/17',
    url: 'http://uptimebot.org/',
  },
  {
    pattern: 'Nmap Scripting Engine',
    additionDate: '2019/02/04',
    url: 'https://nmap.org/book/nse.html',
  },
  {
    pattern: '2ip\\.ru',
    additionDate: '2019/02/12',
    url: 'https://2ip.ru/cms/',
  },
  {
    pattern: 'Clickagy',
    additionDate: '2019/02/19',
    url: 'https://www.clickagy.com',
  },
  {
    pattern: 'Caliperbot',
    additionDate: '2019/03/02',
    url: 'http://www.conductor.com/caliperbot',
  },
  {
    pattern: 'MBCrawler',
    additionDate: '2019/03/02',
    url: 'https://monitorbacklinks.com',
  },
  {
    pattern: 'online-webceo-bot',
    additionDate: '2019/03/02',
    url: 'http://online.webceo.com',
  },
  {
    pattern: 'B2B Bot',
    additionDate: '2019/03/02',
    url: null,
  },
  {
    pattern: 'AddSearchBot',
    additionDate: '2019/03/02',
    url: 'http://www.addsearch.com/bot',
  },
  {
    pattern: 'Google Favicon',
    additionDate: '2019/03/14',
    url: null,
  },
  {
    pattern: 'HubSpot',
    additionDate: '2019/04/15',
    url: null,
  },
  {
    pattern: 'Chrome-Lighthouse',
    additionDate: '2019/03/15',
    url: 'https://developers.google.com/speed/pagespeed/insights',
  },
  {
    pattern: 'HeadlessChrome',
    additionDate: '2019/06/17',
    url: 'https://developers.google.com/web/updates/2017/04/headless-chrome',
  },
  {
    pattern: 'CheckMarkNetwork\\/',
    additionDate: '2019/06/30',
    url: 'https://www.checkmarknetwork.com/',
  },
  {
    pattern: 'www\\.uptime\\.com',
    additionDate: '2019/07/21',
    url: 'http://www.uptime.com/uptimebot',
  },
  {
    pattern: 'Streamline3Bot\\/',
    additionDate: '2019/07/21',
    url: 'https://www.ubtsupport.com/legal/Streamline3Bot.php',
  },
  {
    pattern: 'serpstatbot\\/',
    additionDate: '2019/07/25',
    url: 'http://serpstatbot.com',
  },
  {
    pattern: 'MixnodeCache\\/',
    additionDate: '2019/08/04',
    url: 'https://cache.mixnode.com/',
  },
  {
    pattern: '^curl',
    additionDate: '2019/08/15',
    url: 'https://curl.haxx.se/',
  },
  {
    pattern: 'SimpleScraper',
    additionDate: '2019/08/16',
    url: 'https://github.com/ramonkcom/simple-scraper/',
  },
  {
    pattern: 'RSSingBot',
    additionDate: '2019/09/15',
    url: 'http://www.rssing.com',
  },
  {
    pattern: 'Jooblebot',
    additionDate: '2019/09/25',
    url: 'http://jooble.org/jooble-bot',
  },
  {
    pattern: 'fedoraplanet',
    additionDate: '2019/09/28',
    url: 'http://fedoraplanet.org/',
  },
  {
    pattern: 'Friendica',
    additionDate: '2019/09/28',
    url: 'https://hoyer.xyz',
  },
  {
    pattern: 'NextCloud',
    additionDate: '2019/09/30',
    url: 'https://nextcloud.com/',
  },
  {
    pattern: 'Tiny Tiny RSS',
    additionDate: '2019/10/04',
    url: 'http://tt-rss.org/',
  },
  {
    pattern: 'RegionStuttgartBot',
    additionDate: '2019/10/17',
    url: 'http://it.region-stuttgart.de/competenzatlas/unternehmen-suchen/',
  },
  {
    pattern: 'Bytespider',
    additionDate: '2019/11/11',
    url: 'https://stackoverflow.com/questions/57908900/what-is-the-bytespider-user-agent',
  },
  {
    pattern: 'Datanyze',
    additionDate: '2019/11/17',
    url: 'https://www.datanyze.com/dnyzbot/',
  },
  {
    pattern: 'Google-Site-Verification',
    additionDate: '2019/12/11',
    url: 'https://support.google.com/webmasters/answer/9008080',
  },
  {
    pattern: 'TrendsmapResolver',
    additionDate: '2020/02/24',
    url: 'https://www.trendsmap.com/',
  },
  {
    pattern: 'tweetedtimes',
    additionDate: '2020/02/24',
    url: 'https://tweetedtimes.com/',
  },
  {
    pattern: 'NTENTbot',
    additionDate: '2020/02/24',
    url: 'https://ntent.com/ntentbot/',
  },
  {
    pattern: 'Gwene',
    additionDate: '2020/02/24',
    url: 'https://gwene.org',
  },
  {
    pattern: 'SimplePie',
    additionDate: '2020/02/24',
    url: 'http://simplepie.org',
  },
  {
    pattern: 'SearchAtlas',
    additionDate: '2020/03/02',
    url: 'http://SearchAtlas.com',
  },
  {
    pattern: 'Superfeedr',
    additionDate: '2020/03/02',
    url: 'http://superfeedr.com',
  },
  {
    pattern: 'feedbot',
    additionDate: '2020/03/02',
    url: 'http://wp.com',
  },
  {
    pattern: 'UT-Dorkbot',
    additionDate: '2020/03/02',
    url: 'https://security.utexas.edu/dorkbot',
  },
  {
    pattern: 'Amazonbot',
    additionDate: '2020/03/02',
    url: 'https://developer.amazon.com/support/amazonbot',
  },
  {
    pattern: 'AmazonProductDiscovery',
    additionDate: '2025/12/22',
    url: 'https://vendorcentral.amazon.com/support/amazonproductbot',
  },
  {
    pattern: 'AmazonSellerInitiatedListing',
    additionDate: '2025/12/22',
    url: 'https://vendorcentral.amazon.com/support/amazonproductbot',
  },
  {
    pattern: 'SerendeputyBot',
    additionDate: '2020/03/02',
    url: 'http://serendeputy.com/about/serendeputy-bot',
  },
  {
    pattern: 'Eyeotabot',
    additionDate: '2020/03/02',
    url: 'http://www.eyeota.com',
  },
  {
    pattern: 'officestorebot',
    additionDate: '2020/03/02',
    url: 'https://aka.ms/officestorebot',
  },
  {
    pattern: 'Neticle Crawler',
    additionDate: '2020/03/02',
    url: 'https://neticle.com/bot/en/',
  },
  {
    pattern: 'SurdotlyBot',
    additionDate: '2020/03/02',
    url: 'http://sur.ly/bot.html',
  },
  {
    pattern: 'LinkisBot',
    additionDate: '2020/03/02',
    url: null,
  },
  {
    pattern: 'AwarioSmartBot',
    additionDate: '2020/03/02',
    url: 'https://awario.com/bots.html',
  },
  {
    pattern: 'AwarioRssBot',
    additionDate: '2020/03/02',
    url: 'https://awario.com/bots.html',
  },
  {
    pattern: 'RyteBot',
    additionDate: '2020/03/02',
    url: 'https://bot.ryte.com/',
  },
  {
    pattern: 'FreeWebMonitoring SiteChecker',
    additionDate: '2020/03/02',
    url: 'https://www.freewebmonitoring.com/bot.html',
  },
  {
    pattern: 'AspiegelBot',
    additionDate: '2020/03/16',
    url: 'https://aspiegel.com',
  },
  {
    pattern: 'NAVER Blog Rssbot',
    additionDate: '2020/03/16',
    url: 'http://www.naver.com',
  },
  {
    pattern: 'zenback bot',
    additionDate: '2020/03/16',
    url: 'http://corp.logly.co.jp/',
  },
  {
    pattern: 'SentiBot',
    additionDate: '2020/03/16',
    url: 'https://sites.google.com/senti1.com/sentibot-eu/home',
  },
  {
    pattern: 'Domains Project\\/',
    additionDate: '2020/03/16',
    url: 'https://github.com/tb0hdan/domains',
  },
  {
    pattern: 'Pandalytics',
    additionDate: '2020/03/16',
    url: 'https://domainsbot.com/pandalytics/',
  },
  {
    pattern: 'VKRobot',
    additionDate: '2020/03/16',
    url: null,
  },
  {
    pattern: 'bidswitchbot',
    additionDate: '2020/03/16',
    url: 'https://www.bidswitch.com/about-us/',
  },
  {
    pattern: 'tigerbot',
    additionDate: '2020/03/16',
    url: null,
  },
  {
    pattern: 'NIXStatsbot',
    additionDate: '2020/03/16',
    url: 'http://www.nixstats.com/bot.html',
  },
  {
    pattern: 'Atom Feed Robot',
    additionDate: '2020/03/16',
    url: 'https://rssmicro.com',
  },
  {
    pattern: '[Cc]urebot',
    additionDate: '2020/03/16',
    url: null,
  },
  {
    pattern: 'PagePeeker\\/',
    additionDate: '2020/03/16',
    url: 'https://pagepeeker.com/robots/',
  },
  {
    pattern: 'Vigil\\/',
    additionDate: '2020/03/16',
    url: 'http://vigil-app.com/bot.html',
  },
  {
    pattern: 'rssbot\\/',
    additionDate: '2020/03/16',
    url: 'https://github.com/iovxw/rssbot',
  },
  {
    pattern: 'startmebot\\/',
    additionDate: '2020/03/16',
    url: 'https://start.me/bot',
  },
  {
    pattern: 'JobboerseBot',
    additionDate: '2020/03/16',
    url: 'http://www.jobboerse.com/bot.htm',
  },
  {
    pattern: 'seewithkids',
    additionDate: '2020/03/16',
    url: 'http://seewithkids.com/bot',
  },
  {
    pattern: 'NINJA bot',
    additionDate: '2020/03/16',
    url: null,
  },
  {
    pattern: 'Cutbot',
    additionDate: '2020/03/16',
    url: 'http://cutbot.net/',
  },
  {
    pattern: 'BublupBot',
    additionDate: '2020/03/16',
    url: 'https://www.bublup.com/bublup-bot.html',
  },
  {
    pattern: 'BrandONbot',
    additionDate: '2020/03/16',
    url: 'http://brandonmedia.net',
  },
  {
    pattern: 'RidderBot',
    additionDate: '2020/03/16',
    url: 'https://ridder.co/',
  },
  {
    pattern: 'Taboolabot',
    additionDate: '2020/03/16',
    url: 'http://www.taboola.com',
  },
  {
    pattern: 'Dubbotbot',
    additionDate: '2020/03/16',
    url: 'http://dubbot.com',
  },
  {
    pattern: 'FindITAnswersbot',
    additionDate: '2020/03/16',
    url: 'http://search.it-influentials.com/bot.htm',
  },
  {
    pattern: 'infoobot',
    additionDate: '2020/03/16',
    url: 'https://www.infoo.nl/bot.html',
  },
  {
    pattern: 'Refindbot',
    additionDate: '2020/03/16',
    url: 'https://refind.com/about',
  },
  {
    pattern: 'BlogTraffic\\/\\d\\.\\d+ Feed-Fetcher',
    additionDate: '2020/03/16',
    url: 'http://www.blogtraffic.de/rss-bot.html',
  },
  {
    pattern: 'SeobilityBot',
    additionDate: '2020/03/16',
    url: 'https://www.seobility.net/sites/bot.html',
  },
  {
    pattern: 'Cincraw',
    additionDate: '2020/03/16',
    url: 'http://cincrawdata.net/bot/',
  },
  {
    pattern: 'Dragonbot',
    additionDate: '2020/03/16',
    url: 'http://www.dragonmetrics.com',
  },
  {
    pattern: 'VoluumDSP-content-bot',
    additionDate: '2020/03/16',
    url: 'https://codewise.com',
  },
  {
    pattern: 'FreshRSS',
    additionDate: '2020/03/16',
    url: 'https://freshrss.org',
  },
  {
    pattern: 'BitBot',
    additionDate: '2020/03/16',
    url: 'https://bitbot.dev',
  },
  {
    pattern: '^PHP-Curl-Class',
    additionDate: '2020/12/10',
    url: 'https://github.com/php-curl-class/php-curl-class',
  },
  {
    pattern: 'Google-Certificates-Bridge',
    additionDate: '2020/12/23',
    url: null,
  },
  {
    pattern: 'centurybot',
    additionDate: '2022/04/26',
    url: null,
  },
  {
    pattern: 'Viber',
    additionDate: '2021/04/27',
    url: 'https://www.viber.com/',
  },
  {
    pattern: 'e\\.ventures Investment Crawler',
    additionDate: '2021/06/05',
    url: 'https://www.eventures.vc/',
  },
  {
    pattern: 'evc-batch',
    additionDate: '2021/06/07',
    url: 'https://www.eventures.vc/',
  },
  {
    pattern: 'PetalBot',
    additionDate: '2021/06/07',
    url: 'https://webmaster.petalsearch.com/site/petalbot',
  },
  {
    pattern: 'virustotal',
    additionDate: '2021/09/22',
    url: 'https://www.virustotal.com/gui/home/url',
  },
  {
    pattern: '(^| )PTST\\/',
    additionDate: '2021/12/05',
    url: 'https://www.webpagetest.org',
  },
  {
    pattern: 'minicrawler',
    additionDate: '2022/01/12',
    url: 'https://www.testomato.com/bot',
  },
  {
    pattern: 'Cookiebot',
    additionDate: '2022/01/23',
    url: 'https://www.cookiebot.com/',
  },
  {
    pattern: 'trovitBot',
    additionDate: '2022/06/08',
    url: 'http://www.trovit.com/bot.html',
  },
  {
    pattern: 'seostar\\.co',
    additionDate: '2022/08/04',
    url: 'https://seostar.co/robot/',
  },
  {
    pattern: 'IonCrawl',
    additionDate: '2022/08/04',
    url: 'https://www.ionos.de/terms-gtc/faq-crawler-en',
  },
  {
    pattern: 'Uptime-Kuma',
    additionDate: '2022/10/17',
    url: 'https://uptime.kuma.pet/',
  },
  {
    pattern: 'Seekport',
    additionDate: '2022/10/17',
    url: 'https://bot.seekport.com',
  },
  {
    pattern: 'FreshpingBot',
    additionDate: '2022/10/17',
    url: 'https://www.freshworks.com/website-monitoring/',
  },
  {
    pattern: 'Feedbin',
    additionDate: '2022/11/05',
    url: 'https://feedbin.com/',
  },
  {
    pattern: 'CriteoBot',
    additionDate: '2022/11/13',
    url: 'https://www.criteo.com/',
  },
  {
    pattern: 'Snap URL Preview Service',
    additionDate: '2022/11/13',
    url: 'https://snap.com/',
  },
  {
    pattern: 'Better Uptime Bot',
    additionDate: '2022/11/13',
    url: 'https://betteruptime.com/',
  },
  {
    pattern: 'RuxitSynthetic',
    additionDate: '2023/02/16',
    url: 'https://www.dynatrace.com/support/help/platform-modules/digital-experience/synthetic-monitoring/browser-monitors/configure-browser-monitors#expand--default-user-agent',
  },
  {
    pattern: 'Google-Read-Aloud',
    additionDate: '2023/02/16',
    url: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
  },
  {
    pattern: 'Valve\\/Steam',
    additionDate: '2023/05/24',
    url: null,
  },
  {
    pattern: 'OdklBot\\/',
    additionDate: '2023/05/24',
    url: 'https://odnoklassniki.ru/',
  },
  {
    pattern: 'GPTBot',
    additionDate: '2023/08/09',
    url: 'https://platform.openai.com/docs/gptbot',
  },
  {
    pattern: 'ChatGPT-User',
    additionDate: '2024/04/19',
    url: 'https://openai.com/bot',
  },
  {
    pattern: 'OAI-SearchBot',
    additionDate: '2024/09/24',
    url: 'https://platform.openai.com/docs/bots',
  },
  {
    pattern: 'YandexRenderResourcesBot\\/',
    additionDate: '2023/08/16',
    url: 'http://yandex.com/bots',
  },
  {
    pattern: 'LightspeedSystemsCrawler',
    additionDate: '2023/08/16',
    url: null,
  },
  {
    pattern: 'ev-crawler\\/',
    additionDate: '2023/08/16',
    url: 'https://headline.com/legal/crawler',
  },
  {
    pattern: 'BitSightBot\\/',
    additionDate: '2023/08/16',
    url: 'https://www.bitsight.com',
  },
  {
    pattern: 'woorankreview\\/',
    additionDate: '2023/08/16',
    url: 'https://www.woorank.com/',
  },
  {
    pattern: 'Google-Safety',
    additionDate: '2023/08/17',
    url: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
  },
  {
    pattern: 'AwarioBot',
    additionDate: '2023/08/23',
    url: 'https://awario.com/bots.html',
  },
  {
    pattern: 'DataForSeoBot',
    additionDate: '2023/08/23',
    url: 'https://dataforseo.com/dataforseo-bot',
  },
  {
    pattern: 'Linespider',
    additionDate: '2023/08/24',
    url: 'https://help2.line.me/linesearchbot/web/?contentId=50006055&lang=en',
  },
  {
    pattern: 'WellKnownBot',
    additionDate: '2023/08/29',
    url: 'https://well-known.dev/about/#bot)',
  },
  {
    pattern: 'A Patent Crawler',
    additionDate: '2023/08/29',
    url: 'http://scitas.epfl.ch/',
  },
  {
    pattern: 'StractBot',
    additionDate: '2023/09/06',
    url: 'https://trystract.com/webmasters',
  },
  {
    pattern: 'search\\.marginalia\\.nu',
    additionDate: '2023/09/08',
    url: 'https://search.marginalia.nu',
  },
  {
    pattern: 'YouBot',
    additionDate: '2023/09/08',
    url: 'https://you.com/',
  },
  {
    pattern: 'Nicecrawler',
    additionDate: '2023/09/08',
    url: 'http://www.nicecrawler.com/',
  },
  {
    pattern: 'Neevabot',
    additionDate: '2023/09/08',
    url: 'https://neeva.com/neevabot',
  },
  {
    pattern: 'BrightEdge Crawler',
    additionDate: '2023/09/08',
    url: 'https://www.brightedge.com/',
  },
  {
    pattern: 'SiteCheckerBotCrawler',
    additionDate: '2023/09/08',
    url: 'http://sitechecker.pro',
  },
  {
    pattern: 'TombaPublicWebCrawler',
    additionDate: '2023/09/08',
    url: 'https://tombascraper.com',
  },
  {
    pattern: 'CrawlyProjectCrawler',
    additionDate: '2023/09/08',
    url: 'https://crawlyproject.digitaldragon.dev/',
  },
  {
    pattern: 'KomodiaBot',
    additionDate: '2023/09/08',
    url: 'http://www.komodia.com/newwiki/index.php/URL_server_crawler',
  },
  {
    pattern: 'KStandBot',
    additionDate: '2023/09/08',
    url: 'http://url-classification.io',
  },
  {
    pattern: 'CISPA Webcrawler',
    additionDate: '2023/09/08',
    url: 'https://vuln-notify-checker.cispa.saarland',
  },
  {
    pattern: 'MTRobot',
    additionDate: '2023/09/08',
    url: 'https://metrics-tools.de/robot.html',
  },
  {
    pattern: 'hyscore\\.io',
    additionDate: '2023/09/08',
    url: 'https://hyscore.io/crawler/',
  },
  {
    pattern: 'AlexandriaOrgBot',
    additionDate: '2023/09/08',
    url: 'https://www.alexandria.org/bot.html',
  },
  {
    pattern: '2ip bot',
    additionDate: '2023/09/08',
    url: 'http://2ip.io',
  },
  {
    pattern: 'Yellowbrandprotectionbot',
    additionDate: '2023/09/08',
    url: 'https://www.yellowbp.com/bot.html',
  },
  {
    pattern: 'SEOlizer',
    additionDate: '2023/09/08',
    url: 'https://www.seolizer.de/bot.html',
  },
  {
    pattern: 'vuhuvBot',
    additionDate: '2023/09/08',
    url: 'http://vuhuv.com/bot.html',
  },
  {
    pattern: 'INETDEX-BOT',
    additionDate: '2023/09/08',
    url: 'https://inetdex.com/bot.html',
  },
  {
    pattern: 'Synapse',
    additionDate: '2023/09/08',
    url: 'https://github.com/matrix-org/synapse',
  },
  {
    pattern: 't3versionsBot',
    additionDate: '2023/09/08',
    url: 'https://www.t3versions.com/bot',
  },
  {
    pattern: 'deepnoc',
    additionDate: '2023/09/08',
    url: 'https://deepnoc.com/bot',
  },
  {
    pattern: 'Cocolyzebot',
    additionDate: '2023/09/08',
    url: 'https://cocolyze.com/bot',
  },
  {
    pattern: 'hypestat',
    additionDate: '2023/09/08',
    url: 'https://hypestat.com/bot',
  },
  {
    pattern: 'ReverseEngineeringBot',
    additionDate: '2023/09/08',
    url: 'https://torus.company/bot.html',
  },
  {
    pattern: 'sempi\\.tech',
    additionDate: '2023/09/08',
    url: 'http://sempi.tech/bot.html',
  },
  {
    pattern: 'Iframely',
    additionDate: '2023/09/08',
    url: 'https://iframely.com/docs/about',
  },
  {
    pattern: 'MetaInspector',
    additionDate: '2023/09/08',
    url: 'https://github.com/jaimeiniesta/metainspector',
  },
  {
    pattern: 'node-fetch',
    additionDate: '2023/09/08',
    url: 'https://github.com/bitinn/node-fetch',
  },
  {
    pattern: 'l9explore',
    additionDate: '2023/09/08',
    url: 'https://github.com/LeakIX/l9explore',
  },
  {
    pattern: 'python-opengraph',
    additionDate: '2023/09/08',
    url: 'https://github.com/jaywink/python-opengraph',
  },
  {
    pattern: 'OpenGraphCheck',
    additionDate: '2023/09/08',
    url: 'https://opengraphcheck.com',
  },
  {
    pattern: 'developers\\.google\\.com\\/\\+\\/web\\/snippet',
    additionDate: '2023/09/08',
    url: 'https://developers.google.com/+/web/snippet',
  },
  {
    pattern: 'SenutoBot',
    additionDate: '2023/09/08',
    url: 'https://www.senuto.com',
  },
  {
    pattern: 'MaCoCu',
    additionDate: '2023/09/08',
    url: 'https://www.clarin.si/info/macocu-massive-collection-and-curation-of-monolingual-and-bilingual-data',
  },
  {
    pattern: 'NewsBlur',
    additionDate: '2023/09/08',
    url: 'http://www.newsblur.com',
  },
  {
    pattern: 'inoreader',
    additionDate: '2023/09/08',
    url: 'http://inoreader.com',
  },
  {
    pattern: 'NetSystemsResearch',
    additionDate: '2023/09/08',
    url: 'http://netsystemsresearch.com',
  },
  {
    pattern: 'PageThing',
    additionDate: '2023/09/08',
    url: 'http://pagething.com',
  },
  {
    pattern: 'WordPress\\/',
    additionDate: '2023/10/24',
    url: 'https://wordpress.org',
  },
  {
    pattern: 'PhxBot',
    additionDate: '2024/01/06',
    url: null,
  },
  {
    pattern: 'ImagesiftBot',
    additionDate: '2024/01/06',
    url: 'https://imagesift.com/about',
  },
  {
    pattern: 'Expanse',
    additionDate: '2024/02/01',
    url: 'https://www.paloaltonetworks.com/cortex/cortex-xpanse',
  },
  {
    pattern: 'InternetMeasurement',
    additionDate: '2024/02/01',
    url: 'https://internet-measurement.com',
  },
  {
    pattern: '^BW\\/',
    additionDate: '2024/02/08',
    url: 'https://builtwith.com/biup',
  },
  {
    pattern: 'GeedoBot',
    additionDate: '2024/02/11',
    url: 'http://www.geedo.com',
  },
  {
    pattern: 'Audisto Crawler',
    additionDate: '2024/03/14',
    url: 'https://audisto.com/help/crawler/bot/',
  },
  {
    pattern: 'PerplexityBot\\/',
    additionDate: '2024/03/14',
    url: 'https://docs.perplexity.ai/docs/perplexitybot',
  },
  {
    pattern: '[cC]laude[bB]ot',
    additionDate: '2024/04/19',
    url: 'https://www.anthropic.com/',
  },
  {
    pattern: 'Monsidobot',
    additionDate: '2024/05/14',
    url: 'http://monsido.com/bot.html',
  },
  {
    pattern: 'GroupMeBot',
    additionDate: '2024/05/19',
    url: 'https://groupme.com/',
  },
  {
    pattern: 'Vercelbot',
    additionDate: '2024/08/30',
    url: 'https://github.com/vercel/vercel/discussions/5095#discussioncomment-58705',
  },
  {
    pattern: 'vercel-screenshot',
    additionDate: '2024/08/30',
    url: null,
  },
  {
    pattern: 'facebookcatalog\\/',
    additionDate: '2024/10/03',
    url: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers',
  },
  {
    pattern: 'meta-externalads\\/',
    additionDate: '2025/08/08',
    url: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers',
  },
  {
    pattern: 'meta-externalagent\\/',
    additionDate: '2024/10/03',
    url: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers',
  },
  {
    pattern: 'meta-externalfetcher\\/',
    additionDate: '2024/10/03',
    url: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers',
  },
  {
    pattern: 'AcademicBotRTU',
    additionDate: '2024/10/17',
    url: 'https://academicbot.rtu.lv',
  },
  {
    pattern: 'KeybaseBot',
    additionDate: '2024/10/21',
    url: 'https://book.keybase.io/docs/chat/link-previews',
  },
  {
    pattern: 'Lemmy',
    additionDate: '2025/02/11',
    url: 'https://leminal.space',
  },
  {
    pattern: 'CookieHubScan',
    additionDate: '2024/11/29',
    url: 'https://www.cookiehub.com/',
  },
  {
    pattern: 'Hydrozen\\.io',
    additionDate: '2025/02/02',
    url: 'https://docs.hydrozen.io/overview/misc/user-agent-and-ip-list',
  },
  {
    pattern: 'HTTP Banner Detection',
    additionDate: '2025/02/10',
    url: 'https://security.ipip.net',
  },
  {
    pattern: 'SummalyBot',
    additionDate: '2025/02/10',
    url: 'https://github.com/misskey-dev/summaly',
  },
  {
    pattern: 'MicrosoftPreview\\/',
    additionDate: '2025/02/11',
    url: 'https://www.bing.com/webmasters/help/which-crawlers-does-bing-use-8c184ec0',
  },
  {
    pattern: 'GeedoProductSearch',
    additionDate: '2025/03/15',
    url: 'http://www.geedo.com/product-search.html',
  },
  {
    pattern: 'TikTokSpider',
    additionDate: '2025/03/16',
    url: null,
  },
  {
    pattern: 'OnCrawl\\/',
    additionDate: '2025/03/27',
    url: 'http://www.oncrawl.com',
  },
  {
    pattern: 'sindresorhus\\/got',
    additionDate: '2025/04/22',
    url: 'https://github.com/sindresorhus/got',
  },
  {
    pattern: 'CensysInspect\\/',
    additionDate: '2025/04/22',
    url: 'https://about.censys.io',
  },
  {
    pattern: 'SBIntuitionsBot\\/',
    additionDate: '2025/04/23',
    url: 'https://www.sbintuitions.co.jp/bot/',
  },
  {
    pattern: 'sitebulb',
    additionDate: '2025/04/30',
    url: 'https://sitebulb.com/',
  },
  {
    pattern: 'YextBot\\/',
    additionDate: '2025/08/08',
    url: 'https://hitchhikers.yext.com/modules/kg140-yext-site-crawler/01-create-a-crawler/',
  },
  {
    pattern: 'DatadogSynthetics',
    additionDate: '2025/08/19',
    url: 'https://docs.datadoghq.com/synthetics/',
  },
  {
    pattern: 'Google-Ads-Conversions',
    additionDate: '2025/09/10',
    url: 'https://developers.google.com/google-ads/api/docs/conversions/upload-online',
  },
  {
    pattern: 'ObservePoint',
    additionDate: '2025/12/23',
    url: 'https://help.observepoint.com/en/articles/9101465-allow-exclude-observepoint-traffic#h_2a8176c9b9',
  },
  {
    pattern: 'Checkly',
    additionDate: '2026/02/11',
    url: 'https://www.checklyhq.com/docs/',
  },
  {
    pattern: 'ALittle Client',
    additionDate: '2026/04/07',
    url: 'https://udger.com/resources/ua-list/bot-detail?bot=ALittle+Client',
  },
  {
    pattern: 'AliyunSecBot',
    additionDate: '2026/04/07',
    url: 'https://service.alibaba.com',
  },
  {
    pattern: 'Claude-Web',
    additionDate: '2026/04/07',
    url: 'https://anthropic.com',
  },
  {
    pattern: 'anthropic-ai',
    additionDate: '2026/04/07',
    url: 'https://anthropic.com',
  },
  {
    pattern: 'Claude-User',
    additionDate: '2026/04/07',
    url: 'https://useragents.io/uas/mozilla-5-0-applewebkit-537-36-khtml-like-gecko-compatible-claudebot-1-0-supportanthropic-com_954fa13a8e1e46d8267fb56e2d48100e',
  },
  {
    pattern: 'Claude-SearchBot',
    additionDate: '2026/04/07',
    url: 'https://useragents.io/uas/mozilla-5-0-applewebkit-537-36-khtml-like-gecko-compatible-claudebot-1-0-supportanthropic-com_954fa13a8e1e46d8267fb56e2d48100e',
  },
  {
    pattern: 'Google-Extended',
    additionDate: '2026/04/07',
    url: 'https://developers.google.com/search/docs/crawling-indexing/overview-google-crawlers',
  },
  {
    pattern: 'cohere-ai',
    additionDate: '2026/04/07',
    url: 'https://cohere.com',
  },
  {
    pattern: 'Timpibot',
    additionDate: '2026/04/07',
    url: 'https://timpi.io',
  },
  {
    pattern: 'SERankingBacklinksBot',
    additionDate: '2026/04/07',
    url: 'https://seranking.com/backlinks-crawler',
  },
  {
    pattern: 'CMSChecker',
    additionDate: '2026/04/07',
    url: null,
  },
  {
    pattern: 'Wayback',
    additionDate: '2026/04/07',
    url: 'https://archive.org',
  },
  {
    pattern: 'Playwright',
    additionDate: '2026/04/07',
    url: 'https://playwright.dev',
  },
  {
    pattern: 'Puppeteer',
    additionDate: '2026/04/07',
    url: 'https://pptr.dev',
  },
  {
    pattern: 'Selenium',
    additionDate: '2026/04/07',
    url: 'https://www.selenium.dev',
  },
  {
    pattern: 'Nikto',
    additionDate: '2026/04/07',
    url: 'https://cirt.net/Nikto2',
  },
  {
    pattern: 'sqlmap',
    additionDate: '2026/04/07',
    url: 'https://sqlmap.org',
  },
  {
    pattern: 'ZmEu',
    additionDate: '2026/04/07',
    url: 'https://en.wikipedia.org/wiki/ZmEu_(vulnerability_scanner)',
  },
  {
    pattern: 'masscan',
    additionDate: '2026/04/07',
    url: 'https://github.com/robertdavidgraham/masscan',
  },
  {
    pattern: 'WPScan',
    additionDate: '2026/04/07',
    url: 'https://wpscan.com',
  },
  {
    pattern: '[aA]cunetix',
    additionDate: '2026/04/07',
    url: 'https://www.acunetix.com',
  },
  {
    pattern: 'Nessus',
    additionDate: '2026/04/07',
    url: 'https://www.tenable.com/products/nessus',
  },
  {
    pattern: '[dD]ir[Bb]uster',
    additionDate: '2026/04/07',
    url: 'https://github.com/KajanM/DirBuster',
  },
  {
    pattern: 'StatusCake',
    additionDate: '2026/04/07',
    url: 'https://www.statuscake.com',
  },
  {
    pattern: 'colly',
    additionDate: '2026/04/07',
    url: 'https://go-colly.org',
  },
  {
    pattern: '[mM]echanize',
    additionDate: '2026/04/07',
    url: 'https://github.com/sparklemotion/mechanize',
  },
  {
    pattern: 'air\\.ai\\/scanning',
    additionDate: '2026/04/07',
    url: null,
  },
  {
    pattern: 'asnriskscorer',
    additionDate: '2026/04/07',
    url: null,
  },
  {
    pattern: 'OICrawler',
    additionDate: '2026/04/07',
    url: 'https://openindex.ai',
  },
  {
    pattern: 'l9scan',
    additionDate: '2026/04/07',
    url: 'https://github.com/LeakIX/l9scan',
  },
  {
    pattern: 'SlaccaleBot',
    additionDate: '2026/04/07',
    url: null,
  },
  {
    pattern: 'CustomAsyncHttpClient',
    additionDate: '2026/04/07',
    url: null,
  },
  {
    pattern: '^HTTPie\\/',
    additionDate: '2026/04/07',
    url: 'https://httpie.io',
  },
  {
    pattern: 'Gemini-Deep-Research',
    additionDate: '2026/04/07',
    url: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers',
  },
  {
    pattern: 'Perplexity-User',
    additionDate: '2026/04/07',
    url: 'https://docs.perplexity.ai/guides/bots',
  },
  {
    pattern: 'PerplexityUser',
    additionDate: '2026/04/07',
    url: 'https://perplexity.ai',
  },
  {
    pattern: 'meta-webindexer',
    additionDate: '2026/04/07',
    url: 'https://developers.facebook.com/docs/sharing/webmasters/web-crawlers#meta-webindexer',
  },
  {
    pattern: 'DuckAssistBot',
    additionDate: '2026/04/07',
    url: 'https://duckduckgo.com/duckduckgo-help-pages/results/duckassistbot',
  },
  {
    pattern: 'MistralAI-User',
    additionDate: '2026/04/07',
    url: null,
  },
  {
    pattern: 'webzio',
    additionDate: '2026/04/07',
    url: 'https://webz.io/blog/company/from-omgilibot-to-the-webzbot-duo-a-powerful-leap-for-ethical-and-comprehensive-data-collection/#',
  },
  {
    pattern: 'newsai\\/',
    additionDate: '2026/04/14',
    url: 'https://knownagents.com/agents/newsai',
  },
  {
    pattern: '^ArenaUnfurlBot',
    additionDate: '2026/04/26',
    url: 'https://arena.ai/',
  },
  {
    pattern: 'A360-Search',
    additionDate: '2026/04/26',
    url: 'https://area360.uk/',
  },
  {
    pattern: 'AASA-Bot',
    additionDate: '2026/04/26',
    url: 'https://developer.apple.com/documentation/xcode/allowing-apps-and-websites-to-link-to-your-content',
  },
  {
    pattern: 'AccessStatus',
    additionDate: '2026/04/26',
    url: 'https://accesslink.fr/page/a-propos-de-accessstatus/',
  },
  {
    pattern: 'Acquia optimize',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/acquia-optimize-monsido',
  },
  {
    pattern: 'ActiveComply',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/activecomply-bot',
  },
  {
    pattern: 'AdkernelTopicCrawler',
    additionDate: '2026/04/26',
    url: 'http://adkernel.com/robot/',
  },
  {
    pattern: 'AlertSite',
    additionDate: '2026/04/26',
    url: 'https://smartbear.com/product/alertsite/',
  },
  {
    pattern: 'AllAfrica',
    additionDate: '2026/04/26',
    url: 'https://allafrica.com/misc/info/about/',
  },
  {
    pattern: 'Amazing-SearchBot',
    additionDate: '2026/04/26',
    url: 'https://amazing.com/bot.html',
  },
  {
    pattern: 'Amazon-Bedrock-AgentCore-Browser',
    additionDate: '2026/04/26',
    url: 'https://docs.aws.amazon.com/bedrock-agentcore/',
  },
  {
    pattern: 'AmazonBuyForMe',
    additionDate: '2026/04/26',
    url: 'https://buyforme.amazon/',
  },
  {
    pattern: 'Amzn-SearchBot',
    additionDate: '2026/04/26',
    url: 'https://developer.amazon.com/amazonbot',
  },
  {
    pattern: 'Amzn-User',
    additionDate: '2026/04/26',
    url: 'https://developer.amazon.com/amazonbot',
  },
  {
    pattern: 'Anchor Browser',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/anchor-browser',
  },
  {
    pattern: 'Anomura',
    additionDate: '2026/04/26',
    url: 'https://docs.direqt-search.com/direqt-bots/direqt-crawlers-and-user-agents',
  },
  {
    pattern: 'AP3A\\.240617\\.008',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/008',
  },
  {
    pattern: 'ApifyBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/apifybot',
  },
  {
    pattern: 'ApifyWebsiteContentCrawler',
    additionDate: '2026/04/26',
    url: 'https://apify.com/apify/website-content-crawler',
  },
  {
    pattern: 'Archive-It',
    additionDate: '2026/04/26',
    url: 'http://archive-it.org/files/site-owners-special.html',
  },
  {
    pattern: 'artemis web reader',
    additionDate: '2026/04/26',
    url: 'https://artemis.jamesg.blog/bot',
  },
  {
    pattern: 'atlassian-bot',
    additionDate: '2026/04/26',
    url: 'https://support.atlassian.com/organization-administration/docs/connect-custom-website-to-rovo/',
  },
  {
    pattern: 'Attracta',
    additionDate: '2026/04/26',
    url: 'https://attracta.com/',
  },
  {
    pattern: 'AudigentAdBot',
    additionDate: '2026/04/26',
    url: 'http://audigent.com/bot.html',
  },
  {
    pattern: 'Authory',
    additionDate: '2026/04/26',
    url: 'https://authory.com/about',
  },
  {
    pattern: 'Automaton|Newsify Feed Fetcher',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/automaton',
  },
  {
    pattern: 'AwarioRendererBot',
    additionDate: '2026/04/26',
    url: 'https://awario.com/help/',
  },
  {
    pattern: 'AzureAI-SearchBot',
    additionDate: '2026/04/26',
    url: 'https://azure.microsoft.com/en-us/products/ai-services',
  },
  {
    pattern: 'BestChange',
    additionDate: '2026/04/26',
    url: 'https://bestchange.com/',
  },
  {
    pattern: 'bigsur\\.ai',
    additionDate: '2026/04/26',
    url: 'https://bigsur.ai/',
  },
  {
    pattern: 'bl\\.uk_lddc_bot',
    additionDate: '2026/04/26',
    url: 'https://bl.uk/legal-deposit-web-archiving',
  },
  {
    pattern: 'BlingERP',
    additionDate: '2026/04/26',
    url: 'https://bling.com.br/',
  },
  {
    pattern: 'Blockaid',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/blockaid',
  },
  {
    pattern: 'Bloglines',
    additionDate: '2026/04/26',
    url: 'http://bloglines.com/',
  },
  {
    pattern: 'BlogVault',
    additionDate: '2026/04/26',
    url: 'https://blogvault.net/',
  },
  {
    pattern: 'bluesky-domain-status-classifier',
    additionDate: '2026/04/26',
    url: 'https://blueskyweb.xyz/',
  },
  {
    pattern: 'Bluesky\\/',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/bluesky-link-preview-service',
  },
  {
    pattern: 'bne\\.es_bot',
    additionDate: '2026/04/26',
    url: 'https://bne.es/es/colecciones/archivo-web-espanola/aviso-webmasters',
  },
  {
    pattern: 'Brightbot',
    additionDate: '2026/04/26',
    url: 'https://brightdata.com/brightbot',
  },
  {
    pattern: 'BrowserBot-Observer',
    additionDate: '2026/04/26',
    url: 'https://obsrvr.net/about',
  },
  {
    pattern: 'BufferLinkPreviewBot',
    additionDate: '2026/04/26',
    url: 'https://scraper.buffer.com/about/bots/link-preview-bot',
  },
  {
    pattern: 'Bugsnag',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/bugsnag-script-fetcher',
  },
  {
    pattern: 'Buttondown',
    additionDate: '2026/04/26',
    url: 'https://buttondown.email/features',
  },
  {
    pattern: 'CapitalOneBot',
    additionDate: '2026/04/26',
    url: 'https://developer.capitalone.com/',
  },
  {
    pattern: 'CertChief',
    additionDate: '2026/04/26',
    url: 'https://cert.chief.app/',
  },
  {
    pattern: 'channable',
    additionDate: '2026/04/26',
    url: 'https://channable.com/',
  },
  {
    pattern: 'Channel3Bot',
    additionDate: '2026/04/26',
    url: 'https://trychannel3.com/channel3bot',
  },
  {
    pattern: 'Chirp|gotosocial',
    additionDate: '2026/04/26',
    url: 'http://binarycanary.com/',
  },
  {
    pattern: 'ClickUpLinkUnfurler',
    additionDate: '2026/04/26',
    url: 'https://clickup.com/',
  },
  {
    pattern: 'Cloudflare-AutoRAG',
    additionDate: '2026/04/26',
    url: 'https://developers.cloudflare.com/autorag',
  },
  {
    pattern: 'Cloudflare-Custom-Hostname-Verification',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/cloudflare-custom-hostname-verification',
  },
  {
    pattern: 'Cloudflare-Stream-Webhook',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/cloudflare-stream-webhook',
  },
  {
    pattern: 'CloudflareRadarURLScanner',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/cloudflare-radar-url-scanner',
  },
  {
    pattern: 'Cloudtrellis',
    additionDate: '2026/04/26',
    url: 'https://cloudtrellis.com/',
  },
  {
    pattern: '[cC]ludo',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/cludo',
  },
  {
    pattern: 'Code\\/1\\.',
    additionDate: '2026/04/26',
    url: 'https://github.com/features/copilot',
  },
  {
    pattern: 'Collapsify',
    additionDate: '2026/04/26',
    url: 'https://developers.cloudflare.com/',
  },
  {
    pattern: 'ContextualBot[\\s\\S]*outcomes\\.net',
    additionDate: '2026/04/26',
    url: 'http://outcomes.net/',
  },
  {
    pattern: 'Convermax',
    additionDate: '2026/04/26',
    url: 'https://docs.convermax.com/',
  },
  {
    pattern: 'cookie-maestro',
    additionDate: '2026/04/26',
    url: 'https://cookiemaestro.com/documentatie/limit-cookie-maestro-using-robots-txt',
  },
  {
    pattern: 'CookieHubVerify',
    additionDate: '2026/04/26',
    url: 'https://cookiehub.com/',
  },
  {
    pattern: 'CookieYesbot',
    additionDate: '2026/04/26',
    url: 'http://cookieyes.com/documentation/cookieyesbot',
  },
  {
    pattern: 'Crazy Egg',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/crazy-egg',
  },
  {
    pattern: 'Current[\\s\\S]*RSS Reader',
    additionDate: '2026/04/26',
    url: 'https://currentreader.app/',
  },
  {
    pattern: 'cypex\\.ai\\/scanning',
    additionDate: '2026/04/26',
    url: 'https://cypex.ai/',
  },
  {
    pattern: 'DeepCrawl',
    additionDate: '2026/04/26',
    url: 'https://lumar.io/spdr/',
  },
  {
    pattern: 'DigiCert DCV',
    additionDate: '2026/04/26',
    url: 'https://digicert.com/',
  },
  {
    pattern: 'dlvr\\.it',
    additionDate: '2026/04/26',
    url: 'http://dlvr.it/',
  },
  {
    pattern: 'Dotcom-Monitor',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/doctom-monitor',
  },
  {
    pattern: 'DrataAutopilot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/drata-autopilot',
  },
  {
    pattern: 'DreamHost Data Team',
    additionDate: '2026/04/26',
    url: 'http://dreamhost.com/support/',
  },
  {
    pattern: 'ds9',
    additionDate: '2026/04/26',
    url: 'https://data.dss.sps.copyright.com/docs/user_agent.html',
  },
  {
    pattern: ' DVbot',
    additionDate: '2026/04/26',
    url: 'http://doubleverify.com/',
  },
  {
    pattern: 'EcoVadisSustainabilityBot',
    additionDate: '2026/04/26',
    url: 'https://ecovadis.com/',
  },
  {
    pattern: 'elmah\\.io Uptime Monitoring',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/elmah-io-uptime-monitoring',
  },
  {
    pattern: 'EvernoteRichLinkBot',
    additionDate: '2026/04/26',
    url: 'https://evernote.com/',
  },
  {
    pattern: 'EzLynx',
    additionDate: '2026/04/26',
    url: 'http://ezoic.com/bot.html',
  },
  {
    pattern: 'EzoicBot',
    additionDate: '2026/04/26',
    url: 'https://ezoic.com/bot/',
  },
  {
    pattern: 'FacebookBot',
    additionDate: '2026/04/26',
    url: 'https://developers.facebook.com/docs/sharing/bot/',
  },
  {
    pattern: 'FastDAST',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/black-duck-fast-dynamic',
  },
  {
    pattern: 'Feeder \\/',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/feeder',
  },
  {
    pattern: 'FeedFlow',
    additionDate: '2026/04/26',
    url: 'https://feedflow.dev/',
  },
  {
    pattern: 'FindFiles\\.net',
    additionDate: '2026/04/26',
    url: 'https://findfiles.net/bot',
  },
  {
    pattern: 'FirecrawlAgent',
    additionDate: '2026/04/26',
    url: 'https://firecrawl.dev/',
  },
  {
    pattern: 'FyndSearchEngine-Crawler',
    additionDate: '2026/04/26',
    url: 'https://fynd.bot/',
  },
  {
    pattern: 'FyndSearchEngine-ReCrawler',
    additionDate: '2026/04/26',
    url: 'https://fynd.bot/',
  },
  {
    pattern: 'Goodreads',
    additionDate: '2026/04/26',
    url: 'https://goodreads.com/',
  },
  {
    pattern: 'Google Trust Services',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/google-trust-services-dcv-check',
  },
  {
    pattern: 'Google-Agent',
    additionDate: '2026/04/26',
    url: 'https://developers.google.com/crawling/docs/crawlers-fetchers/google-user-triggered-fetchers',
  },
  {
    pattern: 'Google-Gemini-CLI',
    additionDate: '2026/04/26',
    url: 'https://geminicli.com/',
  },
  {
    pattern: 'Google-NotebookLM',
    additionDate: '2026/04/26',
    url: 'https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers',
  },
  {
    pattern: 'GoogleAgent-Mariner',
    additionDate: '2026/04/26',
    url: 'https://deepmind.google/technologies/project-mariner/',
  },
  {
    pattern: 'Greppr Web Crawler',
    additionDate: '2026/04/26',
    url: 'https://greppr.org/',
  },
  {
    pattern: 'Hardenize',
    additionDate: '2026/04/26',
    url: 'https://hardenize.com/',
  },
  {
    pattern: 'HoneybadgerBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/honeybadgerbot',
  },
  {
    pattern: 'IbouBot',
    additionDate: '2026/04/26',
    url: 'https://ibou.io/iboubot.html',
  },
  {
    pattern: 'imageSpider',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/imagespider',
  },
  {
    pattern: 'Innologica',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/innologica',
  },
  {
    pattern: 'kagi-fetcher',
    additionDate: '2026/04/26',
    url: 'https://help.kagi.com/kagi/ai/kagi-ai.html',
  },
  {
    pattern: 'Kangaroo Bot',
    additionDate: '2026/04/26',
    url: 'https://kangaroollm.com.au/kangaroo-bot/',
  },
  {
    pattern: 'Known Agent',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/',
  },
  {
    pattern: 'KrawlerBot',
    additionDate: '2026/04/26',
    url: 'https://krawler.app/robot',
  },
  {
    pattern: 'laion-huggingface-processor',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/laion-huggingface-processor',
  },
  {
    pattern: 'LinkCheckerBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/linkchecker-bot',
  },
  {
    pattern: 'LinkupBot',
    additionDate: '2026/04/26',
    url: 'https://linkup.so/bot',
  },
  {
    pattern: 'LMArenaUnfurlBot',
    additionDate: '2026/04/26',
    url: 'https://lmarena.ai/',
  },
  {
    pattern: 'lyonl-asset-proxy',
    additionDate: '2026/04/26',
    url: 'https://lyonl.com/crawler',
  },
  {
    pattern: 'lyonl-crawler',
    additionDate: '2026/04/26',
    url: 'https://lyonl.com/crawler',
  },
  {
    pattern: 'MagiBot',
    additionDate: '2026/04/26',
    url: 'https://magi.com/bots',
  },
  {
    pattern: 'MagpieRSS',
    additionDate: '2026/04/26',
    url: 'http://magpierss.sf.net/',
  },
  {
    pattern: 'mail\\.ru',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/mailrubot',
  },
  {
    pattern: 'MailChimp',
    additionDate: '2026/04/26',
    url: 'http://mailchimp.com/',
  },
  {
    pattern: 'Manus-User',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/manus-user',
  },
  {
    pattern: 'McontextualBot',
    additionDate: '2026/04/26',
    url: 'http://mcontextual.net/mcontextual-bot',
  },
  {
    pattern: 'Mediumbot-MetaTagFetcher',
    additionDate: '2026/04/26',
    url: 'https://medium.com/',
  },
  {
    pattern: 'MetaIAB Facebook',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/facebook',
  },
  {
    pattern: 'MixrankBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/mixrankbot',
  },
  {
    pattern: 'ModernizeBot',
    additionDate: '2026/04/26',
    url: 'https://modernizeyourwebsite.com/bot',
  },
  {
    pattern: 'MontasticMonitor',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/montasticmonitor',
  },
  {
    pattern: 'NanoInteractive',
    additionDate: '2026/04/26',
    url: 'https://nanointeractive.com/crawler/',
  },
  {
    pattern: 'NestDaddybot',
    additionDate: '2026/04/26',
    url: 'https://nestdaddy.com/bot',
  },
  {
    pattern: 'Netcraft SSL Server Survey',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/netcraft-ssl-server-survey',
  },
  {
    pattern: 'Netcraft Web Server Survey',
    additionDate: '2026/04/26',
    url: 'https://netcraft.com/blog/june-2025-web-server-survey',
  },
  {
    pattern: 'NetSeer crawler',
    additionDate: '2026/04/26',
    url: 'http://netseer.com/crawler.html',
  },
  {
    pattern: 'Netumo|netumo',
    additionDate: '2026/04/26',
    url: 'https://docs.netumo.com/',
  },
  {
    pattern: 'NewRelicSynthetics',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/new-relic',
  },
  {
    pattern: 'NewsRoom\\.BI',
    additionDate: '2026/04/26',
    url: 'http://newsroom.bi/bot.html',
  },
  {
    pattern: 'Nitro-',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/nitro',
  },
  {
    pattern: 'NitroBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/nitrobot',
  },
  {
    pattern: 'Noibu',
    additionDate: '2026/04/26',
    url: 'https://noibu.com/',
  },
  {
    pattern: 'NostoCrawlerBot',
    additionDate: '2026/04/26',
    url: 'http://my.nosto.com/tagging',
  },
  {
    pattern: 'OneTrust',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/onetrust-cmp-scanner',
  },
  {
    pattern: 'opencode-smartfetch',
    additionDate: '2026/04/26',
    url: 'https://opencode.ai/',
  },
  {
    pattern: ';Owler',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/owler',
  },
  {
    pattern: 'ParselySharesBot',
    additionDate: '2026/04/26',
    url: 'https://docs.parse.ly/',
  },
  {
    pattern: 'PhindBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/phindbot',
  },
  {
    pattern: 'PodchaserParser',
    additionDate: '2026/04/26',
    url: 'https://podchaser.com/',
  },
  {
    pattern: 'Podimo',
    additionDate: '2026/04/26',
    url: 'https://podimo.com/',
  },
  {
    pattern: 'Poggio-Citations',
    additionDate: '2026/04/26',
    url: 'https://docs.poggio.io/api/robots',
  },
  {
    pattern: 'productsup\\.io\\/crawler',
    additionDate: '2026/04/26',
    url: 'https://help.productsup.com/en/29437-29446-import-data-by-crawling-your-website.html',
  },
  {
    pattern: 'qcbot',
    additionDate: '2026/04/26',
    url: 'http://quic.cloud/bot.html',
  },
  {
    pattern: 'Qualys',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/qualys',
  },
  {
    pattern: 'Quora-Bot',
    additionDate: '2026/04/26',
    url: 'http://quora.com/',
  },
  {
    pattern: 'Qwantbot',
    additionDate: '2026/04/26',
    url: 'https://help.qwant.com/',
  },
  {
    pattern: 'Qwarrybot',
    additionDate: '2026/04/26',
    url: 'http://qwarry.com/bot.html',
  },
  {
    pattern: 'RSiteAuditor',
    additionDate: '2026/04/26',
    url: 'https://dataforseo.com/apis/on-page-api',
  },
  {
    pattern: 'RSS\\.Social',
    additionDate: '2026/04/26',
    url: 'https://rss.social/bot',
  },
  {
    pattern: 'Salesforce\\.com',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/sfdc-callout',
  },
  {
    pattern: 'Scope3',
    additionDate: '2026/04/26',
    url: 'https://docs.scope3.com/docs/scope3-crawler',
  },
  {
    pattern: 'scraping@nytimes\\.com',
    additionDate: '2026/04/26',
    url: 'https://github.com/nytimes',
  },
  {
    pattern: 'Scrubby',
    additionDate: '2026/04/26',
    url: 'http://scrubtheweb.com/',
  },
  {
    pattern: 'Scrunchbot',
    additionDate: '2026/04/26',
    url: 'https://scrunchai.com/bots',
  },
  {
    pattern: 'seo4ajax\\.com',
    additionDate: '2026/04/26',
    url: 'https://seo4ajax.com/',
  },
  {
    pattern: 'SequelWP',
    additionDate: '2026/04/26',
    url: 'https://sequelwp.com/',
  },
  {
    pattern: 'ServerDensity',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/server-density',
  },
  {
    pattern: 'ShapBot',
    additionDate: '2026/04/26',
    url: 'https://docs.parallel.ai/resources/crawler',
  },
  {
    pattern: 'ShortPixel',
    additionDate: '2026/04/26',
    url: 'https://shortpixel.com/',
  },
  {
    pattern: 'Silktide',
    additionDate: '2026/04/26',
    url: 'https://silktide.com/',
  },
  {
    pattern: 'SiteLock',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/sitelock',
  },
  {
    pattern: 'SmarshBot',
    additionDate: '2026/04/26',
    url: 'https://smarsh.com/platform/compliance-management/web-archive',
  },
  {
    pattern: 'SMTnetPMBot',
    additionDate: '2026/04/26',
    url: 'https://smtnet.com/',
  },
  {
    pattern: 'Snapchat[\\s\\S]*panda',
    additionDate: '2026/04/26',
    url: 'https://developers.snap.com/robots',
  },
  {
    pattern: 'Software-Security-Research',
    additionDate: '2026/04/26',
    url: 'https://reverse-proxies-measurements.softsec.ruhr-uni-bochum.de/',
  },
  {
    pattern: 'SottopopNone',
    additionDate: '2026/04/26',
    url: 'https://upcontent.com/robots',
  },
  {
    pattern: 'Spider[\\s\\S]*spider\\.com',
    additionDate: '2026/04/26',
    url: 'https://www.spider.com/solutions/web-crawler',
  },
  {
    pattern: 'Splunk',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/splunk',
  },
  {
    pattern: 'StatusNestBacklinkSpider',
    additionDate: '2026/04/26',
    url: 'https://statusnest.com/bot',
  },
  {
    pattern: 'stepstoneCrawlBot',
    additionDate: '2026/04/26',
    url: 'https://thestepstonegroup.com/crawler/',
  },
  {
    pattern: 'TavilyBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/tavilybot',
  },
  {
    pattern: 'ThousandEyes',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/thousand-eyes-cloud-agent',
  },
  {
    pattern: 'Trae\\/',
    additionDate: '2026/04/26',
    url: 'https://trae.ai/',
  },
  {
    pattern: 'TwinAgent',
    additionDate: '2026/04/26',
    url: 'https://twin.so/',
  },
  {
    pattern: 'uipbot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/uipbot',
  },
  {
    pattern: 'um-FC',
    additionDate: '2026/04/26',
    url: 'https://ubermetrics-technologies.com/',
  },
  {
    pattern: 'um-IC',
    additionDate: '2026/04/26',
    url: 'https://ubermetrics-technologies.com/',
  },
  {
    pattern: 'UptimeStatistics',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/uptimestatistics',
  },
  {
    pattern: 'Verispider',
    additionDate: '2026/04/26',
    url: 'http://projecthoneypot.org/',
  },
  {
    pattern: 'visionheight\\.com\\/scan',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/visionheight-comscan',
  },
  {
    pattern: 'Watchbot monitoring robot',
    additionDate: '2026/04/26',
    url: 'https://watchbot.fflow.net/',
  },
  {
    pattern: 'Watchful',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/watchful',
  },
  {
    pattern: 'weborama-fetcher',
    additionDate: '2026/04/26',
    url: 'http://weborama.com/',
  },
  {
    pattern: 'webspidermount',
    additionDate: '2026/04/26',
    url: 'https://webspidermount.com/features/',
  },
  {
    pattern: 'WepchSearchEngine',
    additionDate: '2026/04/26',
    url: 'https://wepch.com/search-engine',
  },
  {
    pattern: 'wknd-bot',
    additionDate: '2026/04/26',
    url: 'https://developer.wunderkind.co/docs/server-side-tracking-implementation',
  },
  {
    pattern: 'WPMU DEV Hub',
    additionDate: '2026/04/26',
    url: 'https://wpmudev.com/',
  },
  {
    pattern: 'WTotem',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/wtotem',
  },
  {
    pattern: 'XoviOnpageCrawler',
    additionDate: '2026/04/26',
    url: 'http://xovi.de/',
  },
  {
    pattern: 'yelpspider',
    additionDate: '2026/04/26',
    url: 'https://yelp.com/',
  },
  {
    pattern: 'ZanistaBot',
    additionDate: '2026/04/26',
    url: 'https://zanista.ai/crawler-info',
  },
  {
    pattern: 'ZoomInfo-',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/zoominfo',
  },
  {
    pattern: '7Siters',
    additionDate: '2026/04/26',
    url: 'https://7ooo.ru/siters/',
  },
  {
    pattern: 'Accessible Web Bot',
    additionDate: '2026/04/26',
    url: 'https://accessibleweb.com/bot/',
  },
  {
    pattern: 'AtVowBot',
    additionDate: '2026/04/26',
    url: 'https://brandeem.com/',
  },
  {
    pattern: 'Bibliotheque Nacional de France Crawler',
    additionDate: '2026/04/26',
    url: 'https://www.bnf.fr/en/web-legal-deposit',
  },
  {
    pattern: 'Bling ERP',
    additionDate: '2026/04/26',
    url: 'https://www.bling.com.br/',
  },
  {
    pattern: 'CDSCbot',
    additionDate: '2026/04/26',
    url: 'https://wiki.communitydata.science/CommunityData:Fediverse_research',
  },
  {
    pattern: 'Critical CSS Bot',
    additionDate: '2026/04/26',
    url: 'https://criticalcss.com/',
  },
  {
    pattern: 'CybaaBot',
    additionDate: '2026/04/26',
    url: 'https://cybaa.io/bot-policy',
  },
  {
    pattern: 'CyberFindCrawler',
    additionDate: '2026/04/26',
    url: 'https://cyberfind.net/bot.html',
  },
  {
    pattern: 'Dark Visitor',
    additionDate: '2026/04/26',
    url: 'https://darkvisitors.com/',
  },
  {
    pattern: 'Determ',
    additionDate: '2026/04/26',
    url: 'https://www.determ.com/',
  },
  {
    pattern: 'DNSScanner',
    additionDate: '2026/04/26',
    url: 'https://rapef.info/_contacts/',
  },
  {
    pattern: 'Drupalbot',
    additionDate: '2026/04/26',
    url: 'https://www.drupal.org/',
  },
  {
    pattern: 'eMoney Advisor',
    additionDate: '2026/04/26',
    url: 'https://emoneyadvisor.com/',
  },
  {
    pattern: 'everyfeed-spider',
    additionDate: '2026/04/26',
    url: 'http://everyfeed.com/',
  },
  {
    pattern: 'ExteContextCrawl',
    additionDate: '2026/04/26',
    url: 'http://crawl001.exte.ai/',
  },
  {
    pattern: 'FediDB',
    additionDate: '2026/04/26',
    url: 'https://fedidb.org/crawler.html',
  },
  {
    pattern: 'FediIndex',
    additionDate: '2026/04/26',
    url: 'https://fedi.wrm.sr/about',
  },
  {
    pattern: 'FediList Agent',
    additionDate: '2026/04/26',
    url: 'https://fedilist.com/',
  },
  {
    pattern: 'Fedineko',
    additionDate: '2026/04/26',
    url: 'https://fedineko.org/about',
  },
  {
    pattern: 'FedReporter Bot for FFIEC',
    additionDate: '2026/04/26',
    url: 'https://www.fedreporter.com/',
  },
  {
    pattern: 'Feedsearch Bot',
    additionDate: '2026/04/26',
    url: 'https://feedearch.dev/',
  },
  {
    pattern: 'Feedsearch-Crawler',
    additionDate: '2026/04/26',
    url: 'https://pypi.org/project/feedsearch-crawler',
  },
  {
    pattern: 'fiperbot',
    additionDate: '2026/04/26',
    url: 'https://fiper.net/',
  },
  {
    pattern: 'FleebsBot',
    additionDate: '2026/04/26',
    url: 'https://fleebs.com/bot',
  },
  {
    pattern: 'Fluid',
    additionDate: '2026/04/26',
    url: 'http://leak.info/bot.html',
  },
  {
    pattern: 'Flyriverbot',
    additionDate: '2026/04/26',
    url: 'https://flyriver.com/crawler',
  },
  {
    pattern: 'Freshbot',
    additionDate: '2026/04/26',
    url: 'http://webagent.wise-guys.nl/',
  },
  {
    pattern: 'Gaisbot',
    additionDate: '2026/04/26',
    url: 'http://gais.cs.ccu.edu.tw/robot.php',
  },
  {
    pattern: 'GenomeCrawlerd',
    additionDate: '2026/04/26',
    url: 'https://nokia.com/genomecrawler',
  },
  {
    pattern: 'HaloBot',
    additionDate: '2026/04/26',
    url: 'https://haloscan.com/',
  },
  {
    pattern: 'IRLbot',
    additionDate: '2026/04/26',
    url: 'http://irl.cs.tamu.edu/crawler',
  },
  {
    pattern: 'kaikki\\.org-digital-archive',
    additionDate: '2026/04/26',
    url: 'https://kaikki.org/',
  },
  {
    pattern: 'kb\\.dk_bot',
    additionDate: '2026/04/26',
    url: 'https://www.kb.dk/en/',
  },
  {
    pattern: 'Library Of Congress Web Archiving',
    additionDate: '2026/04/26',
    url: 'https://www.loc.gov/programs/web-archiving/',
  },
  {
    pattern: 'MagnetmeBot',
    additionDate: '2026/04/26',
    url: 'https://magnet.me/',
  },
  {
    pattern: 'MatchorySearch',
    additionDate: '2026/04/26',
    url: 'https://matchory.com/',
  },
  {
    pattern: "Minoru's Fediverse Crawler",
    additionDate: '2026/04/26',
    url: 'https://nodes.fediverse.party/',
  },
  {
    pattern: 'MirrorWebCrawler',
    additionDate: '2026/04/26',
    url: 'https://www.mirrorweb.com/',
  },
  {
    pattern: 'mithril-crawler',
    additionDate: '2026/04/26',
    url: 'https://498-search-engine.github.io/website/',
  },
  {
    pattern: 'ModatScanner',
    additionDate: '2026/04/26',
    url: 'https://modat.io/',
  },
  {
    pattern: 'NapBot',
    additionDate: '2026/04/26',
    url: 'http://napbot.com/',
  },
  {
    pattern: 'New York Times Newsgathering',
    additionDate: '2026/04/26',
    url: 'https://www.nytimes.com/',
  },
  {
    pattern: 'NLUX_IAHarvester',
    additionDate: '2026/04/26',
    url: 'http://crawl.bnl.lu/',
  },
  {
    pattern: 'NoahBot',
    additionDate: '2026/04/26',
    url: 'https://noahwire.com/bot-info',
  },
  {
    pattern: 'PlagAwareBot',
    additionDate: '2026/04/26',
    url: 'https://plagaware.com/bot',
  },
  {
    pattern: 'Rakuten Image extraction bot',
    additionDate: '2026/04/26',
    url: 'https://www.rakuten.com/',
  },
  {
    pattern: 'ResearchBot',
    additionDate: '2026/04/26',
    url: 'https://kaust.edu.sa/bot',
  },
  {
    pattern: 'rss-is-dead\\.lol web bot',
    additionDate: '2026/04/26',
    url: 'https://rss-is-dead.lol/',
  },
  {
    pattern: 'seoLyt',
    additionDate: '2026/04/26',
    url: 'https://seolyt.com/',
  },
  {
    pattern: 'SirdataBot',
    additionDate: '2026/04/26',
    url: 'https://semantic-api.docs.sirdata.net/contextual-api/contextual-api/introduction',
  },
  {
    pattern: 'SitesOverPagesBot',
    additionDate: '2026/04/26',
    url: 'https://sitesoverpages.com/bot',
  },
  {
    pattern: 'SleepBot',
    additionDate: '2026/04/26',
    url: 'http://sleepbot.com/',
  },
  {
    pattern: 'Sosospider',
    additionDate: '2026/04/26',
    url: 'http://help.soso.com/webspider.htm',
  },
  {
    pattern: 'Termly',
    additionDate: '2026/04/26',
    url: 'https://termly.io/',
  },
  {
    pattern: 'TLS tester',
    additionDate: '2026/04/26',
    url: 'https://testssl.sh/dev/',
  },
  {
    pattern: 'trafilatura',
    additionDate: '2026/04/26',
    url: 'https://github.com/adbar/trafilatura',
  },
  {
    pattern: 'UrlBeeBot',
    additionDate: '2026/04/26',
    url: 'https://urlbee.com/',
  },
  {
    pattern: 'videootv Bot',
    additionDate: '2026/04/26',
    url: 'https://www.digitalgreen.org/',
  },
  {
    pattern: 'vmcrawl',
    additionDate: '2026/04/26',
    url: 'https://docs.vmst.io/vmcrawl',
  },
  {
    pattern: 'WadooBot',
    additionDate: '2026/04/26',
    url: 'https://wadoo.net/wadoobot/',
  },
  {
    pattern: 'Website-info\\.net-Robot',
    additionDate: '2026/04/26',
    url: 'https://website-info.net/robot',
  },
  {
    pattern: 'WebZIP',
    additionDate: '2026/04/26',
    url: 'http://spidersoft.com/',
  },
  {
    pattern: 'WikiDo',
    additionDate: '2026/04/26',
    url: 'http://wikido.com/',
  },
  {
    pattern: 'WOVN Crawler',
    additionDate: '2026/04/26',
    url: 'https://wovn.io/',
  },
  {
    pattern: 'YoudaoBot',
    additionDate: '2026/04/26',
    url: 'http://youdao.com/help/webmaster/spider/',
  },
  {
    pattern: 'ZyBorg',
    additionDate: '2026/04/26',
    url: 'http://wisenutbot.com/',
  },
  {
    pattern: 'Aranet-SearchBot',
    additionDate: '2026/04/26',
    url: 'https://aranet.ai/bot',
  },
  {
    pattern: 'crawl4ai',
    additionDate: '2026/04/26',
    url: 'https://github.com/unclecode/crawl4ai',
  },
  {
    pattern: 'DeepSeekBot',
    additionDate: '2026/04/26',
    url: 'http://deepseek.com/bot',
  },
  {
    pattern: 'iaskspider',
    additionDate: '2026/04/26',
    url: 'https://www.iask.com/',
  },
  {
    pattern: 'KunatoCrawler',
    additionDate: '2026/04/26',
    url: 'http://kunato.ai/bot.html',
  },
  {
    pattern: 'TerraCotta',
    additionDate: '2026/04/26',
    url: 'https://github.com/CeramicTeam/CeramicTerracotta',
  },
  {
    pattern: 'ABEvalBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/abevalbot',
  },
  {
    pattern: 'blekkobot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/blekkobot',
  },
  {
    pattern: 'br-crawler',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/br-crawler',
  },
  {
    pattern: 'BuddyBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/buddybot',
  },
  {
    pattern: 'CapterraBot',
    additionDate: '2026/04/26',
    url: 'https://www.capterra.com',
  },
  {
    pattern: 'carbon-umbrella-bot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/carbon-umbrella-bot',
  },
  {
    pattern: 'caveman-hunter',
    additionDate: '2026/04/26',
    url: 'https://fedi.buzz/',
  },
  {
    pattern: 'Centro Ads\\.txt Crawler',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/centro-ads-txt-crawler',
  },
  {
    pattern: 'WISEbot',
    additionDate: '2026/04/26',
    url: 'http://www.cision.com',
  },
  {
    pattern: 'CodaBot',
    additionDate: '2026/04/26',
    url: 'https://coda.io/',
  },
  {
    pattern: 'Corporama matcher',
    additionDate: '2026/04/26',
    url: 'https://corporama.fr/',
  },
  {
    pattern: 'CyotekWebCopy',
    additionDate: '2026/04/26',
    url: 'https://www.cyotek.com/cyotek-webcopy',
  },
  {
    pattern: 'Datadog Agent',
    additionDate: '2026/04/26',
    url: 'https://www.datadoghq.com/',
  },
  {
    pattern: 'Dazzle BlueSky Bot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/dazzle-bluesky-bot',
  },
  {
    pattern: 'DominicBot',
    additionDate: '2026/04/26',
    url: 'https://vanylla.org/bot',
  },
  {
    pattern: 'Dow Jones Searchbot',
    additionDate: '2026/04/26',
    url: 'https://www.dowjones.com/',
  },
  {
    pattern: 'Download Ninja',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/download-ninja',
  },
  {
    pattern: 'EmailWolf',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/emailwolf',
  },
  {
    pattern: 'fedistatsCrawler',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/fedistatscrawler',
  },
  {
    pattern: 'GoParserBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/goparserbot',
  },
  {
    pattern: 'gsa-crawler',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/gsa-crawler',
  },
  {
    pattern: 'HanaleiBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/hanaleibot',
  },
  {
    pattern: 'NicheIndex',
    additionDate: '2026/04/26',
    url: 'https://nicheindex.co',
  },
  {
    pattern: 'HeadOnlyScraper',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/headonlyscraper',
  },
  {
    pattern: 'HenkBot',
    additionDate: '2026/04/26',
    url: 'https://valyu.ai/crawler',
  },
  {
    pattern: 'Impact\\.com Agent',
    additionDate: '2026/04/26',
    url: 'https://impact.com/',
  },
  {
    pattern: 'Keydrop\\.io',
    additionDate: '2026/04/26',
    url: 'https://onlyscans.com/about',
  },
  {
    pattern: 'larbin',
    additionDate: '2026/04/26',
    url: 'http://larbin.sourceforge.net/',
  },
  {
    pattern: 'SENTINEL-LinkCheck',
    additionDate: '2026/04/26',
    url: 'https://sentinel.oblivionzone.com/bot',
  },
  {
    pattern: 'linko',
    additionDate: '2026/04/26',
    url: 'https://linko.app/crawler',
  },
  {
    pattern: 'LinkpadBot',
    additionDate: '2026/04/26',
    url: 'https://linkpad.org/robot/',
  },
  {
    pattern: 'lwp-trivial',
    additionDate: '2026/04/26',
    url: 'https://metacpan.org/pod/LWP',
  },
  {
    pattern: 'Magus Bot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/magus-bot',
  },
  {
    pattern: 'NaverBot',
    additionDate: '2026/04/26',
    url: 'https://www.naver.com/',
  },
  {
    pattern: 'loopimprovements\\.com',
    additionDate: '2026/04/26',
    url: 'http://loopimprovements.com/robot.html',
  },
  {
    pattern: 'OpenTheBoxBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/opentheboxbot',
  },
  {
    pattern: 'OWLer-W',
    additionDate: '2026/04/26',
    url: 'https://openwebsearch.eu/',
  },
  {
    pattern: 'peer39_crawler',
    additionDate: '2026/04/26',
    url: 'https://www.peer39.com/',
  },
  {
    pattern: 'Pixalate\\.com',
    additionDate: '2026/04/26',
    url: 'https://www.pixalate.com/',
  },
  {
    pattern: 'Poduptime',
    additionDate: '2026/04/26',
    url: 'https://fediverse.observer',
  },
  {
    pattern: 'Pomothy-Bot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/pomothy-bot',
  },
  {
    pattern: 'PulsePoint-Crawler',
    additionDate: '2026/04/26',
    url: 'https://www.pulsepoint.com/',
  },
  {
    pattern: 'rawweb-bot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/rawweb-bot',
  },
  {
    pattern: 'semantic-visions',
    additionDate: '2026/04/26',
    url: 'https://semantic-visions.com/',
  },
  {
    pattern: 'Sindup',
    additionDate: '2026/04/26',
    url: 'https://www.sindup.com/',
  },
  {
    pattern: 'SiteSucker',
    additionDate: '2026/04/26',
    url: 'https://ricks-apps.com/osx/sitesucker/',
  },
  {
    pattern: 'SpringserveBot',
    additionDate: '2026/04/26',
    url: 'https://www.springserve.com/',
  },
  {
    pattern: 'SQWatcher',
    additionDate: '2026/04/26',
    url: 'http://sqcompliance.com/sqwatcher.html',
  },
  {
    pattern: 'Supabase Paired Crawler',
    additionDate: '2026/04/26',
    url: 'https://supabase.com/',
  },
  {
    pattern: 'sv-watchagent',
    additionDate: '2026/04/26',
    url: 'https://semantic-visions.com/',
  },
  {
    pattern: 'Swiftbot',
    additionDate: '2026/04/26',
    url: 'http://swiftype.com/swiftbot',
  },
  {
    pattern: 'SynthesiBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/synthesibot',
  },
  {
    pattern: 'TaraGroup Intelligent Bot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/taragroup-intelligent-bot',
  },
  {
    pattern: 'Thinkbot',
    additionDate: '2026/04/26',
    url: 'https://boston.conman.org/2025/08/21.1',
  },
  {
    pattern: 'TSMbot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/tsmbot',
  },
  {
    pattern: 'TSM-turingos',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/turingos',
  },
  {
    pattern: 'UGAResearchAgent',
    additionDate: '2026/04/26',
    url: 'https://nislabuga-scan.uga.edu/',
  },
  {
    pattern: 'UrlSuMa\\.de crawler',
    additionDate: '2026/04/26',
    url: 'https://urlsuma.de/',
  },
  {
    pattern: 'WanscannerBot',
    additionDate: '2026/04/26',
    url: 'https://abuse.pend.re',
  },
  {
    pattern: 'WebCapture',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/webcapture-2-0',
  },
  {
    pattern: 'WebCopier',
    additionDate: '2026/04/26',
    url: 'http://www.maximumsoft.com/',
  },
  {
    pattern: 'cognitiveseo\\.com',
    additionDate: '2026/04/26',
    url: 'http://cognitiveseo.com/bot.html',
  },
  {
    pattern: 'Xing Bot',
    additionDate: '2026/04/26',
    url: 'https://www.xing.com/',
  },
  {
    pattern: 'XML Sitemaps Generator',
    additionDate: '2026/04/26',
    url: 'http://www.xml-sitemaps.com',
  },
  {
    pattern: 'YandoriRSSBot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/yandorirssbot',
  },
  {
    pattern: 'Zealbot',
    additionDate: '2026/04/26',
    url: 'https://knownagents.com/agents/zealbot',
  },
  {
    pattern: '008\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/008-2/',
  },
  {
    pattern: 'monitoring360bot\\/',
    additionDate: '2026/04/17',
    url: 'https://app.360monitoring.com/bot.html',
  },
  {
    pattern: 'AdagioBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/adagio-digital/',
  },
  {
    pattern: 'adbeat\\.com',
    additionDate: '2026/04/17',
    url: 'https://www.adbeat.com/operation_policy',
  },
  {
    pattern: 'AdminLabs',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/adminlabs/',
  },
  {
    pattern: 'advanced_crawler',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/advanced-crawler/',
  },
  {
    pattern: 'Adventurer',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/adventurer/',
  },
  {
    pattern: 'AGAKIDSBOT',
    additionDate: '2026/04/17',
    url: 'https://agakids.ru/project/',
  },
  {
    pattern: 'AgencyAnalyticsBot',
    additionDate: '2026/04/17',
    url: 'https://agencyanalytics.com/features/seo-site-audit',
  },
  {
    pattern: 'AI2Bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/ai2bot/',
  },
  {
    pattern: 'AkismetBot',
    additionDate: '2026/04/17',
    url: 'https://akismet.com/development/api/',
  },
  {
    pattern: 'alexa site audit',
    additionDate: '2026/04/17',
    url: 'https://www.alexa.com/help/webmasters',
  },
  {
    pattern: 'Algolia Crawler',
    additionDate: '2026/04/17',
    url: 'https://www.algolia.com/doc/',
  },
  {
    pattern: 'alienfarm',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/alienfarm/',
  },
  {
    pattern: 'allOrigins',
    additionDate: '2026/04/17',
    url: 'https://allorigins.win/',
  },
  {
    pattern: 'AmazonAdBot',
    additionDate: '2026/04/17',
    url: 'https://advertising.amazon.com/resources/',
  },
  {
    pattern: 'KendraBot',
    additionDate: '2026/04/17',
    url: 'https://docs.aws.amazon.com/kendra/latest/dg/what-is-kendra.html',
  },
  {
    pattern: 'AppSiteAssociation',
    additionDate: '2026/04/17',
    url: 'https://developer.apple.com/documentation/applications/allowing-app-linking-to-your-website',
  },
  {
    pattern: 'Aragog\\/',
    additionDate: '2026/04/17',
    url: 'https://wordads.co/',
  },
  {
    pattern: 'Aranea',
    additionDate: '2026/04/17',
    url: 'http://unesco.uniba.sk/guest/',
  },
  {
    pattern: 'ArchiveBox',
    additionDate: '2026/04/17',
    url: 'https://archivebox.io/',
  },
  {
    pattern: 'ArquivoBot',
    additionDate: '2026/04/17',
    url: 'https://arquivo.pt/about',
  },
  {
    pattern: 'Arquivo-web-crawler',
    additionDate: '2026/04/17',
    url: 'https://arquivo.pt/robot',
  },
  {
    pattern: 'ArtemisBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/artemis-web-reader/',
  },
  {
    pattern: 'Asana\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/asana-crawler/',
  },
  {
    pattern: 'AudistoBot',
    additionDate: '2026/04/17',
    url: 'https://audisto.com/webcrawler/',
  },
  {
    pattern: 'Autoconfig Test from USTC',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/autoconfig-test-from-ustc/',
  },
  {
    pattern: 'tracking-quality-spider',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/awin-com-crawler/',
  },
  {
    pattern: 'Bad Neighborhood Header Detector',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/bad-neighborhood/',
  },
  {
    pattern: 'BaiduAdsBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/baidu-ads-server-proxy/',
  },
  {
    pattern: 'BDBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/bdbot/',
  },
  {
    pattern: 'BeeperBot',
    additionDate: '2026/04/17',
    url: 'https://www.beeper.com/',
  },
  {
    pattern: 'BetterUptimeBot',
    additionDate: '2026/04/17',
    url: 'https://betteruptime.com/docs',
  },
  {
    pattern: 'BnFBot',
    additionDate: '2026/04/17',
    url: 'https://www.bnf.fr/en/web-services',
  },
  {
    pattern: 'BigUpDataBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/bigupdata/',
  },
  {
    pattern: 'BinaryCanary',
    additionDate: '2026/04/17',
    url: 'https://www.binarycanary.com/monitoring/',
  },
  {
    pattern: 'Bitbucket-Webhooks',
    additionDate: '2026/04/17',
    url: 'https://support.atlassian.com/bitbucket-cloud',
  },
  {
    pattern: 'bl\\.uk_ldfc_bot',
    additionDate: '2026/04/17',
    url: 'https://www.bl.uk/legal-deposit/web-archiving',
  },
  {
    pattern: 'BlackDuck-FD',
    additionDate: '2026/04/17',
    url: 'https://www.synopsys.com/software-integrity/security-testing/dynamic-analysis.html',
  },
  {
    pattern: 'Blogtrottr',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/blogtrottr/',
  },
  {
    pattern: 'BlueskyPreviewBot',
    additionDate: '2026/04/17',
    url: 'https://docs.bsky.app',
  },
  {
    pattern: 'BoardGamePricesBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/boardgameprices/',
  },
  {
    pattern: 'BotPoke',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/botpoke/',
  },
  {
    pattern: 'BDFetch',
    additionDate: '2026/04/17',
    url: 'http://www.brandprotect.com/',
  },
  {
    pattern: 'Brandwatch',
    additionDate: '2026/04/17',
    url: 'https://www.brandwatch.com/legal/crawlers/',
  },
  {
    pattern: 'BraveBot',
    additionDate: '2026/04/17',
    url: 'https://search.brave.com/help/web-discovery-project',
  },
  {
    pattern: 'brokenlinkcheck\\.com',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/brokenlinkcheck-com/',
  },
  {
    pattern: 'BW\\/',
    additionDate: '2026/04/17',
    url: 'https://builtwith.com/biup',
  },
  {
    pattern: 'Bushbaby',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/bushbaby/',
  },
  {
    pattern: 'Butterfly',
    additionDate: '2026/04/17',
    url: 'http://labs.topsy.com/butterfly/',
  },
  {
    pattern: 'rss-parser',
    additionDate: '2026/04/17',
    url: 'https://buttondown.email/about',
  },
  {
    pattern: 'CaliberBot',
    additionDate: '2026/04/17',
    url: 'https://www.calibermind.com/platform',
  },
  {
    pattern: 'CapitalOneShopping',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/capital-one-shopping-bot/',
  },
  {
    pattern: 'Catchpoint',
    additionDate: '2026/04/17',
    url: 'ttps://catchpoint.com/bots',
  },
  {
    pattern: 'centuryb\\.o\\.t9',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/centurybot9/',
  },
  {
    pattern: 'CERT PL',
    additionDate: '2026/04/17',
    url: 'https://cert.pl/skanowanie',
  },
  {
    pattern: 'certytags',
    additionDate: '2026/04/17',
    url: 'https://certybot.certytags.com/',
  },
  {
    pattern: 'ChargeBeeBot',
    additionDate: '2026/04/17',
    url: 'https://chargebee.com/resources',
  },
  {
    pattern: 'Charlotte',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/charlotte-bot/',
  },
  {
    pattern: 'ChatGLM-Spider',
    additionDate: '2026/04/17',
    url: 'https://chatglm.cn/',
  },
  {
    pattern: 'Chatwork LinkPreview',
    additionDate: '2026/04/17',
    url: 'https://www.chatwork.com/',
  },
  {
    pattern: 'CheckHost',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/check-host/',
  },
  {
    pattern: 'Goodzer',
    additionDate: '2026/04/17',
    url: 'https://discord.com/discovery/applications/1065250549408223252',
  },
  {
    pattern: 'Chrome Privacy Preserving Prefetch Proxy',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/chrome-privacypreserving-prefetch-proxy/',
  },
  {
    pattern: 'CirrusExplorer',
    additionDate: '2026/04/17',
    url: 'https://cseu.ro/explorer.php',
  },
  {
    pattern: 'CLASSLA-web',
    additionDate: '2026/04/17',
    url: 'https://www.clarin.si/info/classla-web-crawler/',
  },
  {
    pattern: 'Clearscopebot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/clearscope-clearscopebot/',
  },
  {
    pattern: 'WorldBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/clickagy-intelligence-bot/',
  },
  {
    pattern: 'Cloudflare-Validator',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/cloudflare-crawler/',
  },
  {
    pattern: 'cloudflare-csup',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/cloudflare-csup/',
  },
  {
    pattern: 'Cloudflare-Custom-Error-Page-Crawler',
    additionDate: '2026/04/17',
    url: 'https://developers.cloudflare.com',
  },
  {
    pattern: 'Cloudflare-Radar-Scanner',
    additionDate: '2026/04/17',
    url: 'https://radar.cloudflare.com',
  },
  {
    pattern: 'Cloudflare-SpeedTest',
    additionDate: '2026/04/17',
    url: 'https://www.cloudflare.com/speedtest',
  },
  {
    pattern: 'Cloudflare-Stream-Hook',
    additionDate: '2026/04/17',
    url: 'https://developers.cloudflare.com/stream/webhooks/',
  },
  {
    pattern: 'cognitiveSEO Bot',
    additionDate: '2026/04/17',
    url: 'https://cognitiveseo.com/bot',
  },
  {
    pattern: 'cohere-training-data-crawler',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/cohere-training-data-crawler/',
  },
  {
    pattern: 'CommaFeed',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/commafeed/',
  },
  {
    pattern: 'researchscan\\.comsys\\.rwth-aachen\\.de',
    additionDate: '2026/04/17',
    url: 'http://researchscan.comsys.rwth-aachen.de/',
  },
  {
    pattern: 'contentkingapp',
    additionDate: '2026/04/17',
    url: 'https://whatis.contentkingapp.com/',
  },
  {
    pattern: 'CookieHub Bot',
    additionDate: '2026/04/17',
    url: 'https://www.cookiehub.com/docs',
  },
  {
    pattern: 'Cotoyogi',
    additionDate: '2026/04/17',
    url: 'https://ds.rois.ac.jp/center8/crawler/',
  },
  {
    pattern: 'Coveobot',
    additionDate: '2026/04/17',
    url: 'https://platform.cloud.coveo.com/',
  },
  {
    pattern: 'Crawlson',
    additionDate: '2026/04/17',
    url: 'https://www.crawlson.com/',
  },
  {
    pattern: 'RepoLookoutBot',
    additionDate: '2026/04/17',
    url: 'https://www.repo-lookout.org/',
  },
  {
    pattern: 'Criticalcss\\.com',
    additionDate: '2026/04/17',
    url: 'https://criticalcss.com/',
  },
  {
    pattern: 'cron-job\\.org',
    additionDate: '2026/04/17',
    url: 'https://cron-job.org/en/',
  },
  {
    pattern: 'DnBCrawler',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/dnbcrawler/',
  },
  {
    pattern: 'DMBrowser',
    additionDate: '2026/04/17',
    url: 'https://www.dotcom-monitor.com/wiki/knowledge-base-main/',
  },
  {
    pattern: 'DomCopBot',
    additionDate: '2026/04/17',
    url: 'https://www.domcop.com/bot',
  },
  {
    pattern: 'downnotifier\\.com',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/downnotifier-com-monitoring/',
  },
  {
    pattern: 'DowntimeDetector\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/downtimedetector/',
  },
  {
    pattern: 'Dlc\\/',
    additionDate: '2026/04/17',
    url: 'https://www.drlinkcheck.com/',
  },
  {
    pattern: 'Dratabot',
    additionDate: '2026/04/17',
    url: 'https://dratabot.com',
  },
  {
    pattern: 'EasyBib AutoCite',
    additionDate: '2026/04/17',
    url: 'http://www.easybib.com/',
  },
  {
    pattern: 'easybill-ImportManager',
    additionDate: '2026/04/17',
    url: 'https://www.easybill.de/api/',
  },
  {
    pattern: 'EasyCron\\/',
    additionDate: '2026/04/17',
    url: 'https://www.easycron.com',
  },
  {
    pattern: 'easyDNS Monitoring',
    additionDate: '2026/04/17',
    url: 'http://easyurl.net/monitoring',
  },
  {
    pattern: 'EchoboxBot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.echobox.com/',
  },
  {
    pattern: 'Cronless',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/cronless/',
  },
  {
    pattern: 'crusty\\/',
    additionDate: '2026/04/17',
    url: 'https://github.com/let4be/crusty',
  },
  {
    pattern: 'csirt\\.cz',
    additionDate: '2026/04/17',
    url: 'https://csirt.cz/cs/dns-crawler',
  },
  {
    pattern: 'CXK_Bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/cxk_bot/',
  },
  {
    pattern: 'daumoa',
    additionDate: '2026/04/17',
    url: 'http://cs.daum.net/faq/15/4118.html?faqId=28966',
  },
  {
    pattern: 'DaspeedBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/dawap-bot/',
  },
  {
    pattern: 'Dead Link Checker',
    additionDate: '2026/04/17',
    url: 'http://www.dead-link-checker.com/',
  },
  {
    pattern: 'Deskyobot',
    additionDate: '2026/04/17',
    url: 'https://www.deskyo.com/bot',
  },
  {
    pattern: 'Detectify',
    additionDate: '2026/04/17',
    url: 'https://detectify.com/what-is-detectify',
  },
  {
    pattern: 'Devin',
    additionDate: '2026/04/17',
    url: 'https://docs.devin.ai/get-started/devin-intro',
  },
  {
    pattern: 'DF Bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/df-bot/',
  },
  {
    pattern: 'DingTalkBot-LinkService',
    additionDate: '2026/04/17',
    url: 'https://www.dingtalk.com/',
  },
  {
    pattern: 'Discourse Forum Onebox',
    additionDate: '2026/04/17',
    url: 'https://discourse.org/',
  },
  {
    pattern: 'Dmbot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/dmbot/',
  },
  {
    pattern: 'SustainabilityCrawler',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/ecovadis-bot/',
  },
  {
    pattern: 'edansbot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/edansbot/',
  },
  {
    pattern: 'EdgeWatch',
    additionDate: '2026/04/17',
    url: 'https://about.edgewatch.com/',
  },
  {
    pattern: 'Do Not Track Verifier',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/eff-crawler/',
  },
  {
    pattern: 'elmahio-uptimebot',
    additionDate: '2026/04/17',
    url: 'https://elmah.io',
  },
  {
    pattern: 'eMoneyBot',
    additionDate: '2026/04/17',
    url: 'https://emoneyadvisor.com',
  },
  {
    pattern: 'EpivozCrawler',
    additionDate: '2026/04/17',
    url: 'https://www.techmeme.com',
  },
  {
    pattern: 'eRepublik\\.tools',
    additionDate: '2026/04/17',
    url: 'https://erepublik.tools',
  },
  {
    pattern: 'EvoUptimeBot',
    additionDate: '2026/04/17',
    url: 'https://www.evo.agency',
  },
  {
    pattern: 'ExodusMovement',
    additionDate: '2026/04/17',
    url: 'https://www.exodus.io',
  },
  {
    pattern: 'Ezgif',
    additionDate: '2026/04/17',
    url: 'https://ezgif.com/about',
  },
  {
    pattern: 'factset_spyderbot',
    additionDate: '2026/04/17',
    url: 'https://www.factset.com/',
  },
  {
    pattern: 'FastmailUA',
    additionDate: '2026/04/17',
    url: 'https://www.fastmail.com/policies/bots/',
  },
  {
    pattern: 'FDL Stats Bot',
    additionDate: '2026/04/17',
    url: 'https://ftwentertainment.com',
  },
  {
    pattern: 'Fedicabot',
    additionDate: '2026/04/17',
    url: 'https://fedica.com/info/fedicabot',
  },
  {
    pattern: 'FedReporterDataBot',
    additionDate: '2026/04/17',
    url: 'https://fedreporter.net/FedReporterBotDocumentation/Readme.txt',
  },
  {
    pattern: 'Feed Image Audit',
    additionDate: '2026/04/17',
    url: 'https://image-validator.com/',
  },
  {
    pattern: 'FeedBurner',
    additionDate: '2026/04/17',
    url: 'http://www.feedburner.com/',
  },
  {
    pattern: 'feeder\\.co',
    additionDate: '2026/04/17',
    url: 'https://feeder.co/crawler',
  },
  {
    pattern: 'Feedpresso Content Index Bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/feedpresso-crawler/',
  },
  {
    pattern: 'Feedwind',
    additionDate: '2026/04/17',
    url: 'http://feed.mikle.com/support/description/',
  },
  {
    pattern: 'fidget-spinner-bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/fidget-spinner-bot/',
  },
  {
    pattern: 'FirmoGraph',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/firmograph/',
  },
  {
    pattern: 'FlipboardRSS',
    additionDate: '2026/04/17',
    url: 'http://flipboard.com/browserproxy',
  },
  {
    pattern: 'Foregenix',
    additionDate: '2026/04/17',
    url: 'http://www.foregenix.com/scan',
  },
  {
    pattern: 'Freespoke\\/',
    additionDate: '2026/04/17',
    url: 'https://docs.freespoke.com/search/bot/',
  },
  {
    pattern: 'Friendly testing bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/friendly-testing-bot/',
  },
  {
    pattern: 'friendly-spider',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/friendly-spider/',
  },
  {
    pattern: 'FriendlyCrawler\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/friendlycrawler/',
  },
  {
    pattern: 'FullStoryBot\\/',
    additionDate: '2026/04/17',
    url: 'https://help.fullstory.com/spp-ref/343521-what-is-the-fullstorybot',
  },
  {
    pattern: 'Funnelback',
    additionDate: '2026/04/17',
    url: 'https://docs.squiz.net/funnelback/docs/latest/',
  },
  {
    pattern: 'FuseonBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/fuseonbot/',
  },
  {
    pattern: 'Gabanzabot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/gabanzabot/',
  },
  {
    pattern: 'gdnplus\\.com',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/gdnp-crawler/',
  },
  {
    pattern: 'getthit\\.com',
    additionDate: '2026/04/17',
    url: 'https://www.getthit.com/bot',
  },
  {
    pattern: 'GG PeekBot',
    additionDate: '2026/04/17',
    url: 'https://www.gg.pl/',
  },
  {
    pattern: 'Ghost Inspector',
    additionDate: '2026/04/17',
    url: 'https://ghostinspector.com/',
  },
  {
    pattern: 'github-camo',
    additionDate: '2026/04/17',
    url: 'https://github.com/atmos/camo',
  },
  {
    pattern: 'GlobalWebSearch',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/globalwebsearch/',
  },
  {
    pattern: 'Golfe\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/6hphjxgx/',
  },
  {
    pattern: 'Google-Apps-Script',
    additionDate: '2026/04/17',
    url: 'https://script.google.com/',
  },
  {
    pattern: 'GoogleStackdriverMonitoring',
    additionDate: '2026/04/17',
    url: 'https://cloud.google.com/monitoring',
  },
  {
    pattern: 'GoogleAssociationService\\/',
    additionDate: '2026/04/17',
    url: 'https://developers.google.com/identity/credential-sharing/digital-asset-links#:~:text=then%20act%20upon.-,Overview,as%20location%2C%20with%20website%20B.',
  },
  {
    pattern: 'GoogleImageProxy',
    additionDate: '2026/04/17',
    url: 'https://support.google.com/webmasters/answer/1061943?hl=en',
  },
  {
    pattern: 'GoogleProducer',
    additionDate: '2026/04/17',
    url: 'https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers#googleproducer',
  },
  {
    pattern: 'Googlebot-IA\\/',
    additionDate: '2026/04/17',
    url: 'https://scholar.google.com/intl/en/scholar/libraries.html',
  },
  {
    pattern: 'Google-Trust-Services\\/',
    additionDate: '2026/04/17',
    url: 'https://pki.goog/',
  },
  {
    pattern: 'Google-Area120',
    additionDate: '2026/04/17',
    url: 'https://area120.google.com/',
  },
  {
    pattern: 'Google-CloudVertexBot',
    additionDate: '2026/04/17',
    url: 'https://developers.google.com/search/docs/crawling-indexing/google-common-crawlers#google-cloudvertexbot',
  },
  {
    pattern: 'GoogleAssociationService$',
    additionDate: '2026/04/17',
    url: 'https://developers.google.com/digital-asset-links',
  },
  {
    pattern: 'GoogleDocs',
    additionDate: '2026/04/17',
    url: 'https://docs.google.com/',
  },
  {
    pattern: 'GoPay',
    additionDate: '2026/04/17',
    url: 'https://doc.gopay.com/',
  },
  {
    pattern: 'GotSiteMonitor\\.com',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/gotsitemonitor/',
  },
  {
    pattern: 'synthetic-monitoring-agent\\/',
    additionDate: '2026/04/17',
    url: 'https://grafana.com/',
  },
  {
    pattern: 'Grammarly\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/grammarly/',
  },
  {
    pattern: 'gregcrawler',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/gregcrawler/',
  },
  {
    pattern: 'GroovinaAdsbot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.groovinads.com/',
  },
  {
    pattern: 'Grover\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/grover-bot/',
  },
  {
    pattern: 'GTmetrix',
    additionDate: '2026/04/17',
    url: 'https://gtmetrix.com/',
  },
  {
    pattern: 'GuestpostsBot\\/',
    additionDate: '2026/04/17',
    url: 'https://guestposts.com.br/',
  },
  {
    pattern: 'Gulper Web Bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/gulperbot/',
  },
  {
    pattern: 'Verity\\/',
    additionDate: '2026/04/17',
    url: 'https://gumgum.com/verity',
  },
  {
    pattern: 'HappyWing',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/happywing/',
  },
  {
    pattern: 'harsilbot\\/',
    additionDate: '2026/04/17',
    url: 'http://www.harsil.com/bot',
  },
  {
    pattern: 'HawaiiBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/hawaiibot/',
  },
  {
    pattern: 'hCardValidator',
    additionDate: '2026/04/17',
    url: 'http://hcard.geekhood.net/',
  },
  {
    pattern: 'Hello World',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/hello-world/',
  },
  {
    pattern: 'HelloworkJobPostingBot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.hellowork-group.com/en/',
  },
  {
    pattern: 'HetrixTools',
    additionDate: '2026/04/17',
    url: 'https://hetrixtools.com/uptime-monitoring-bot.html',
  },
  {
    pattern: 'HIFIBot\\/',
    additionDate: '2026/04/17',
    url: 'https://hi.fi/',
  },
  {
    pattern: 'Hlidam\\.to robot',
    additionDate: '2026/04/17',
    url: 'https://hlidam.to/',
  },
  {
    pattern: 'Honeybadger Uptime Check',
    additionDate: '2026/04/17',
    url: 'https://www.honeybadger.io/',
  },
  {
    pattern: 'HostTracker\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/hosttracker/',
  },
  {
    pattern: 'Hotjar',
    additionDate: '2026/04/17',
    url: 'https://www.hotjar.com/',
  },
  {
    pattern: 'hstspreload-bot',
    additionDate: '2026/04/17',
    url: 'https://hstspreload.org/',
  },
  {
    pattern: 'Huckabot\\/',
    additionDate: '2026/04/17',
    url: 'https://huckabuy.com/',
  },
  {
    pattern: 'Hype Machine\\/',
    additionDate: '2026/04/17',
    url: 'https://hypem.com/latest',
  },
  {
    pattern: 'Web Screen Service By hyperhost',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/hyperhost-ua-crawler/',
  },
  {
    pattern: 'AdsBot-IAB',
    additionDate: '2026/04/17',
    url: 'https://iabtechlab.com/ads-txt/',
  },
  {
    pattern: 'iAskBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/iaskspider/',
  },
  {
    pattern: 'IBM Crawler',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/ibm-crawler/',
  },
  {
    pattern: 'IFTTT\\/',
    additionDate: '2026/04/17',
    url: 'https://ifttt.com/feed/details',
  },
  {
    pattern: 'ImageFetcher\\/',
    additionDate: '2026/04/17',
    url: 'http://wsrv.nl/',
  },
  {
    pattern: 'ImageMind',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/imagemind/',
  },
  {
    pattern: 'img2dataset',
    additionDate: '2026/04/17',
    url: 'https://github.com/rom1504/img2dataset',
  },
  {
    pattern: 'imgproxy\\/',
    additionDate: '2026/04/17',
    url: 'https://imgproxy.net/',
  },
  {
    pattern: 'impendoom-bot\\/',
    additionDate: '2026/04/17',
    url: 'https://impendoom.com/',
  },
  {
    pattern: 'IndeedJobBot',
    additionDate: '2026/04/17',
    url: 'https://www.indeed.com/about/indeed-crawlers',
  },
  {
    pattern: 'Innguma\\/',
    additionDate: '2026/04/17',
    url: 'https://factory.innguma.com/fetcher/',
  },
  {
    pattern: 'Instapaper\\/',
    additionDate: '2026/04/17',
    url: 'https://www.instapaper.com/publishers',
  },
  {
    pattern: 'Integromat\\/',
    additionDate: '2026/04/17',
    url: 'https://developers.make.com/api-documentation',
  },
  {
    pattern: 'intelx\\.io_bot',
    additionDate: '2026/04/17',
    url: 'https://intelx.io/',
  },
  {
    pattern: 'internetVista monitor',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/internetvista-monitor/',
  },
  {
    pattern: 'Irokez\\.cz monitoring',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/irokez-cz-monitoring/',
  },
  {
    pattern: 'IsDownBot\\/',
    additionDate: '2026/04/17',
    url: 'https://help.isdown.app/custom-monitors/isdownbot',
  },
  {
    pattern: 'ISSCyberRiskCrawler\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/isscyberriskcrawler/',
  },
  {
    pattern: 'iubenda-radar\\/',
    additionDate: '2026/04/17',
    url: 'https://www.iubenda.com/',
  },
  {
    pattern: 'UptimeBot\\/',
    additionDate: '2026/04/17',
    url: 'https://jaggedpixel.co/',
  },
  {
    pattern: 'jetmon\\/',
    additionDate: '2026/04/17',
    url: 'https://automattic.com/',
  },
  {
    pattern: 'jobswithgptcom-bot',
    additionDate: '2026/04/17',
    url: 'https://jobswithgpt.com/bot.html',
  },
  {
    pattern: 'Jumio',
    additionDate: '2026/04/17',
    url: 'https://github.com/Jumio/implementation-guides/blob/master/netverify/callback.md',
  },
  {
    pattern: 'Kagibot\\/',
    additionDate: '2026/04/17',
    url: 'https://kagi.com/',
  },
  {
    pattern: 'KangarooBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/kangaroo-bot/',
  },
  {
    pattern: 'KargoBot-Artemis',
    additionDate: '2026/04/17',
    url: 'https://www.kargo.com/',
  },
  {
    pattern: 'kazbtbot\\/',
    additionDate: '2026/04/17',
    url: 'http://kazbt.com/',
  },
  {
    pattern: 'keycdn-tools\\/',
    additionDate: '2026/04/17',
    url: 'https://tools.keycdn.com/',
  },
  {
    pattern: 'keys-so-bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/keys-so-bot/',
  },
  {
    pattern: 'kinsta-bot',
    additionDate: '2026/04/17',
    url: 'https://kinsta.com/',
  },
  {
    pattern: 'Klaviyo\\/',
    additionDate: '2026/04/17',
    url: 'https://www.klaviyo.com/',
  },
  {
    pattern: 'Kukei\\.eu-Bot\\/',
    additionDate: '2026/04/17',
    url: 'https://kukei.eu/',
  },
  {
    pattern: 'LAC_IAHarvester',
    additionDate: '2026/04/17',
    url: 'https://library-archives.canada.ca/eng/services/government-canada/web-social-media-preservation-program/Pages/web-archive.aspx',
  },
  {
    pattern: 'LastModBot\\/',
    additionDate: '2026/04/17',
    url: 'https://last-modified.com/',
  },
  {
    pattern: 'LegalMonster',
    additionDate: '2026/04/17',
    url: 'https://www.legalmonster.com/',
  },
  {
    pattern: "Let's Encrypt",
    additionDate: '2026/04/17',
    url: 'https://letsencrypt.org/',
  },
  {
    pattern: 'Level9SearchBot\\/',
    additionDate: '2026/04/17',
    url: 'https://level9.com/',
  },
  {
    pattern: 'loc\\.gov\\/programs\\/web-archiving',
    additionDate: '2026/04/17',
    url: 'https://www.loc.gov/programs/web-archiving/for-site-owners',
  },
  {
    pattern: 'LinerBot\\/',
    additionDate: '2026/04/17',
    url: 'https://docs.getliner.com/docs/linerbot',
  },
  {
    pattern: 'LinkTiger',
    additionDate: '2026/04/17',
    url: 'https://linktiger.com/',
  },
  {
    pattern: 'LinkAce\\/',
    additionDate: '2026/04/17',
    url: 'https://www.linkace.org/',
  },
  {
    pattern: 'LinksIndexerBot\\/',
    additionDate: '2026/04/17',
    url: 'https://linksindexer.com/bot',
  },
  {
    pattern: 'LinkWalker\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/linkwalker/',
  },
  {
    pattern: 'LogicMonitor',
    additionDate: '2026/04/17',
    url: 'https://www.logicmonitor.com/support/about-logicmonitor/overview/logicmonitor-public-ip-addresses-dns-names',
  },
  {
    pattern: 'LoomlyBot',
    additionDate: '2026/04/17',
    url: 'https://www.loomly.com/',
  },
  {
    pattern: 'Macrobondbot',
    additionDate: '2026/04/17',
    url: 'https://www.macrobond.com/',
  },
  {
    pattern: 'MADBbot\\/',
    additionDate: '2026/04/17',
    url: 'https://madb.zapto.org/bot.html',
  },
  {
    pattern: 'Magellan',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/magellan/',
  },
  {
    pattern: 'magicsearchdev\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/magicsearchdev/',
  },
  {
    pattern: 'Magnet\\.me-web\\/',
    additionDate: '2026/04/17',
    url: 'https://magnet.me/bot.html',
  },
  {
    pattern: 'MainWP\\/',
    additionDate: '2026/04/17',
    url: 'https://www.dshost.com.au/',
  },
  {
    pattern: 'Make\\/',
    additionDate: '2026/04/17',
    url: 'https://www.make.com/en/',
  },
  {
    pattern: 'ManageWP',
    additionDate: '2026/04/17',
    url: 'https://managewp.com/',
  },
  {
    pattern: 'MarketGoo\\/',
    additionDate: '2026/04/17',
    url: 'https://www.marketgoo.com/',
  },
  {
    pattern: 'MarketingMiner',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/marketingminer-bot/',
  },
  {
    pattern: 'dbot\\)',
    additionDate: '2026/04/17',
    url: 'https://www.marsflag.com/ja/marsfinder/',
  },
  {
    pattern: 'Mattermost-Bot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/mattermost-bot/',
  },
  {
    pattern: 'Mavifinds',
    additionDate: '2026/04/17',
    url: 'https://brandimi.com/mavifinds-bot/',
  },
  {
    pattern: 'MB-LinkChecker',
    additionDate: '2026/04/17',
    url: 'https://www.marcobeierer.com/tools',
  },
  {
    pattern: 'MedialogiaBot',
    additionDate: '2026/04/17',
    url: 'https://www.mlg.ru/',
  },
  {
    pattern: 'MediaMonitoringBot\\/',
    additionDate: '2026/04/17',
    url: 'https://mediamonitoringbot.com/',
  },
  {
    pattern: 'MediavineMetadataParser\\/',
    additionDate: '2026/04/17',
    url: 'https://radar.cloudflare.com/bots/directory/mediavine-metadata-parser/mediavine.com',
  },
  {
    pattern: 'Pywikibot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.mediawiki.org/wiki/Manual:Pywikibot',
  },
  {
    pattern: 'CentComBot\\/',
    additionDate: '2026/04/17',
    url: 'https://centcom.melonmesa.com/',
  },
  {
    pattern: 'MergadoBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/mergadobot/',
  },
  {
    pattern: 'Meta-ExternalHit\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/meta-externalagent/',
  },
  {
    pattern: 'Metorik',
    additionDate: '2026/04/17',
    url: 'https://metorik.com/',
  },
  {
    pattern: 'MgidBot',
    additionDate: '2026/04/17',
    url: 'https://www.mgid.com',
  },
  {
    pattern: 'Miniature\\.io\\/',
    additionDate: '2026/04/17',
    url: 'https://miniature.io/',
  },
  {
    pattern: 'mirrorweb\\.com',
    additionDate: '2026/04/17',
    url: 'https://www.mirrorweb.com/',
  },
  {
    pattern: 'MissinglettrBot\\/',
    additionDate: '2026/04/17',
    url: 'https://missinglettr.com/',
  },
  {
    pattern: 'crawler_eb_germany',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/crawler_eb_germany/',
  },
  {
    pattern: 'ModularConnector\\/',
    additionDate: '2026/04/17',
    url: 'https://uniqoders.com/',
  },
  {
    pattern: 'Mollie HTTP client',
    additionDate: '2026/04/17',
    url: 'https://www.mollie.com/',
  },
  {
    pattern: 'Monibot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/monibot/',
  },
  {
    pattern: 'monitis -',
    additionDate: '2026/04/17',
    url: 'https://www.monitis.com/',
  },
  {
    pattern: 'MonitoRSS\\/',
    additionDate: '2026/04/17',
    url: 'https://monitorss.xyz/',
  },
  {
    pattern: 'MonSpark\\/',
    additionDate: '2026/04/17',
    url: 'https://monspark.com/',
  },
  {
    pattern: 'montastic-monitor',
    additionDate: '2026/04/17',
    url: 'https://montastic.com/',
  },
  {
    pattern: 'MonTools\\.com',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/montools/',
  },
  {
    pattern: 'MotoMinerBot\\/',
    additionDate: '2026/04/17',
    url: 'https://motominer.com/Bot',
  },
  {
    pattern: 'MRGbot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.mrg.ro/',
  },
  {
    pattern: 'MxToolbox',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/mxtoolbox-bot/',
  },
  {
    pattern: 'my-tiny-bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/my-tiny-bot/',
  },
  {
    pattern: 'MyBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/mybot/',
  },
  {
    pattern: 'nbertaupete95',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/nbertaupete95/',
  },
  {
    pattern: 'NetAPI',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/netapi/',
  },
  {
    pattern: 'NetpeakCheckerBot\\/',
    additionDate: '2026/04/17',
    url: 'https://netpeaksoftware.com/',
  },
  {
    pattern: 'NetShelter ContentScan',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/netshelter-contentscan/',
  },
  {
    pattern: 'NETVIGIE',
    additionDate: '2026/04/17',
    url: 'https://netvigie.com/',
  },
  {
    pattern: 'NewRelicbot\\/',
    additionDate: '2026/04/17',
    url: 'https://newrelic.com/',
  },
  {
    pattern: 'nyt_scraping',
    additionDate: '2026/04/17',
    url: 'https://int.nyt.com/assets/scraping.json',
  },
  {
    pattern: 'NewsNow\\/',
    additionDate: '2026/04/17',
    url: 'https://www.newsnow.co.uk/h/',
  },
  {
    pattern: 'NLNZ_IAHarvester',
    additionDate: '2026/04/17',
    url: 'https://natlib.govt.nz/publishers-and-authors/web-harvesting',
  },
  {
    pattern: 'NodePing',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/nodeping/',
  },
  {
    pattern: 'nomore404\\.com robot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/nomore404-com-robot/',
  },
  {
    pattern: 'noorobot',
    additionDate: '2026/04/17',
    url: 'https://noordigital.com/',
  },
  {
    pattern: 'Nooshub\\/',
    additionDate: '2026/04/17',
    url: 'https://www.nooshub.com/',
  },
  {
    pattern: 'Notabot',
    additionDate: '2026/04/17',
    url: 'https://corp.helpfeel.com/ja/home',
  },
  {
    pattern: 'Novaact\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/novaact/',
  },
  {
    pattern: 'Novellum',
    additionDate: '2026/04/17',
    url: 'https://crawl.corp.novellum.ai/docs',
  },
  {
    pattern: 'NsToolsBot\\/',
    additionDate: '2026/04/17',
    url: 'https://ns.tools/',
  },
  {
    pattern: 'nvdorz',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/nvdorz/',
  },
  {
    pattern: 'Odin;',
    additionDate: '2026/04/17',
    url: 'https://docs.getodin.com/',
  },
  {
    pattern: 'Offline Explorer',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/offline-explorer/',
  },
  {
    pattern: 'OhDear\\/',
    additionDate: '2026/04/17',
    url: 'https://ohdear.app/docs/faq/what-is-the-oh-dear-checker',
  },
  {
    pattern: 'Omnisend\\/',
    additionDate: '2026/04/17',
    url: 'https://bots.omnisend.io/cf.txt',
  },
  {
    pattern: 'Online Domain Tools',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/online-domain-tools/',
  },
  {
    pattern: 'WebCEO Online\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/online-webceo-bot/',
  },
  {
    pattern: 'OnlineOrNot\\.com_bot',
    additionDate: '2026/04/17',
    url: 'https://onlineornot.com',
  },
  {
    pattern: 'OpenGraph\\.io\\/',
    additionDate: '2026/04/17',
    url: 'https://www.opengraph.io/',
  },
  {
    pattern: 'OpenRSS',
    additionDate: '2026/04/17',
    url: 'https://openrss.org/',
  },
  {
    pattern: 'OpenVAS',
    additionDate: '2026/04/17',
    url: 'https://openvas.org/',
  },
  {
    pattern: 'Owler \\(ows\\.eu',
    additionDate: '2026/04/17',
    url: 'https://ows.eu/owler',
  },
  {
    pattern: 'Operator\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/operator/',
  },
  {
    pattern: 'Orbbot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/orbbot/',
  },
  {
    pattern: 'zebra-v2-bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/zebra-v2-bot/',
  },
  {
    pattern: 'Orlo-LinkPreview\\/',
    additionDate: '2026/04/17',
    url: 'https://orlo.tech/',
  },
  {
    pattern: 'Cozi-iCalendar-FeedReader',
    additionDate: '2026/04/17',
    url: 'https://ourfamilywizard.com/',
  },
  {
    pattern: 'OutsellURLValidator',
    additionDate: '2026/04/17',
    url: 'https://www.outsell.com/',
  },
  {
    pattern: 'Overcast\\/',
    additionDate: '2026/04/17',
    url: 'https://overcast.fm/',
  },
  {
    pattern: 'PRTGCloudBot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.paessler.com/',
  },
  {
    pattern: 'Pagespeed\\/',
    additionDate: '2026/04/17',
    url: 'http://www.pagespeed.de/',
  },
  {
    pattern: 'PanguBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/pangubot/',
  },
  {
    pattern: 'Panopta',
    additionDate: '2026/04/17',
    url: 'https://www.panopta.com/',
  },
  {
    pattern: 'Paqlebot\\/',
    additionDate: '2026/04/17',
    url: 'http://www.paqle.dk/about/paqlebot',
  },
  {
    pattern: 'parse\\.ly scraper\\/',
    additionDate: '2026/04/17',
    url: 'https://www.parse.ly/',
  },
  {
    pattern: 'PayPal\\/',
    additionDate: '2026/04/17',
    url: 'https://www.paypal.com/ipn',
  },
  {
    pattern: 'PDF24 URL To PDF',
    additionDate: '2026/04/17',
    url: 'https://tools.pdf24.org/webpage-to-pdf',
  },
  {
    pattern: 'PingAdmin\\.Ru\\/',
    additionDate: '2026/04/17',
    url: 'http://ping-admin.ru/',
  },
  {
    pattern: 'pingping\\.io\\/',
    additionDate: '2026/04/17',
    url: 'https://pingping.io/',
  },
  {
    pattern: 'PlayStore-Google',
    additionDate: '2026/04/17',
    url: 'https://support.google.com/webmasters/answer/1061943',
  },
  {
    pattern: 'Plesk screenshot bot',
    additionDate: '2026/04/17',
    url: 'https://www.plesk.com/',
  },
  {
    pattern: 'PocketCasts\\/',
    additionDate: '2026/04/17',
    url: 'https://support.pocketcasts.com/knowledge-base/pocket-casts-feed-parser/',
  },
  {
    pattern: 'Potions\\/',
    additionDate: '2026/04/17',
    url: 'https://get-potions.com/',
  },
  {
    pattern: 'PressEngineBot',
    additionDate: '2026/04/17',
    url: 'https://www.pressengine.net/',
  },
  {
    pattern: 'PricedroneShoppingBot\\/',
    additionDate: '2026/04/17',
    url: 'http://pricedrone.com/robot/',
  },
  {
    pattern: 'PriEcoBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/priecobot/',
  },
  {
    pattern: 'PrintFriendly\\.com',
    additionDate: '2026/04/17',
    url: 'https://www.printfriendly.com/',
  },
  {
    pattern: 'Pro-Sitemaps\\/',
    additionDate: '2026/04/17',
    url: 'https://pro-sitemaps.com/',
  },
  {
    pattern: 'ProbelySPDR\\/',
    additionDate: '2026/04/17',
    url: 'https://probely.com/sos',
  },
  {
    pattern: 'ProjectShield-UrlCheck',
    additionDate: '2026/04/17',
    url: 'https://projectshield.withgoogle.com/',
  },
  {
    pattern: 'Blackbox Exporter\\/',
    additionDate: '2026/04/17',
    url: 'https://github.com/prometheus/blackbox_exporter',
  },
  {
    pattern: 'Protopage\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/protopage/',
  },
  {
    pattern: 'PS_Daily\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/ps-daily/',
  },
  {
    pattern: 'pulsetic\\.com',
    additionDate: '2026/04/17',
    url: 'https://pulsetic.com/',
  },
  {
    pattern: 'PWABuilderHttpAgent',
    additionDate: '2026/04/17',
    url: 'https://www.pwabuilder.com/',
  },
  {
    pattern: 'QualifiedBot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.qualified.com/legal/qualified-crawler-user-agent',
  },
  {
    pattern: 'Quantcastbot\\/',
    additionDate: '2026/04/17',
    url: 'http://www.quantcast.com/bot',
  },
  {
    pattern: 'Rackspace Monitoring\\/',
    additionDate: '2026/04/17',
    url: 'https://support.rackspace.com/how-to/about-the-rackspace-monitoring-agent/',
  },
  {
    pattern: 'rakutenusabot-image\\/',
    additionDate: '2026/04/17',
    url: 'https://product-image.ebates.com/item-gsp/rakutenusabot.html',
  },
  {
    pattern: 'top100\\.rambler\\.ru crawler',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/rambler-bot/',
  },
  {
    pattern: 'RankurBot\\/',
    additionDate: '2026/04/17',
    url: 'http://rankur.com/technology.html',
  },
  {
    pattern: 'RavenCrawler\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/ravencrawler/',
  },
  {
    pattern: 'Readable\\/',
    additionDate: '2026/04/17',
    url: 'https://readable.com/',
  },
  {
    pattern: 'Recurly Webhooks\\/',
    additionDate: '2026/04/17',
    url: 'https://docs.recurly.com/docs/webhooks',
  },
  {
    pattern: 'RED\\/',
    additionDate: '2026/04/17',
    url: 'https://redbot.org/',
  },
  {
    pattern: 'Reelevant\\/',
    additionDate: '2026/04/17',
    url: 'https://reelevant.com/',
  },
  {
    pattern: 'remove\\.bg\\/',
    additionDate: '2026/04/17',
    url: 'https://www.remove.bg/',
  },
  {
    pattern: 'Retool\\/',
    additionDate: '2026/04/17',
    url: 'https://docs.tryretool.com/docs/apis',
  },
  {
    pattern: 'RetroListeCOM\\/',
    additionDate: '2026/04/17',
    url: 'https://retroliste.com/',
  },
  {
    pattern: 'RevvimGort\\/',
    additionDate: '2026/04/17',
    url: 'https://revvim.com',
  },
  {
    pattern: 'reward-gateway',
    additionDate: '2026/04/17',
    url: 'https://www.rewardgateway.co',
  },
  {
    pattern: 'Riddler \\(http:\\/\\/riddler\\.io',
    additionDate: '2026/04/17',
    url: 'http://riddler.io/about',
  },
  {
    pattern: 'RobotsChecker\\/',
    additionDate: '2026/04/17',
    url: 'http://www.blocked.org.uk/',
  },
  {
    pattern: 'RSSAPI\\/',
    additionDate: '2026/04/17',
    url: 'https://rssapi.net',
  },
  {
    pattern: 'rss2tg',
    additionDate: '2026/04/17',
    url: 'https://rss2tg.duck.consulting',
  },
  {
    pattern: 'RssReaderBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/rssreaderbot/',
  },
  {
    pattern: 's4a-probe-bot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.seo4ajax.com/webscraper/',
  },
  {
    pattern: 'SFDC-Callout\\/',
    additionDate: '2026/04/17',
    url: 'https://help.salesforce.com/articleView?id=000321501&type=1&mode=1',
  },
  {
    pattern: 'page-preview-tool',
    additionDate: '2026/04/17',
    url: 'https://www.salesviewer.com/en/',
  },
  {
    pattern: 'SandobaCrawler\\/',
    additionDate: '2026/04/17',
    url: 'https://www.sandoba.com/en/crawler/',
  },
  {
    pattern: 'Sansec Security Monitor\\/',
    additionDate: '2026/04/17',
    url: 'https://sansec.io/monitor',
  },
  {
    pattern: 'GIFTEDVISITOR SCAN',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/scan/',
  },
  {
    pattern: 'Schema-Markup-Validator',
    additionDate: '2026/04/17',
    url: 'https://validator.schema.org/',
  },
  {
    pattern: 'Scoop\\.it\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/scoop-it/',
  },
  {
    pattern: 'ScourRSSBot\\/',
    additionDate: '2026/04/17',
    url: 'https://scour.ing/bot',
  },
  {
    pattern: 'ScrapeheroBot\\/',
    additionDate: '2026/04/17',
    url: 'https://scrapehero.de/',
  },
  {
    pattern: 'screeenly-bot',
    additionDate: '2026/04/17',
    url: 'https://3.screeenly.com/ua',
  },
  {
    pattern: 'SEBot-WA',
    additionDate: '2026/04/17',
    url: 'https://help.seranking.com/en/project-tools/website-audit/overview',
  },
  {
    pattern: 'Searcherweb',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/searcherweb/',
  },
  {
    pattern: 'Searcherxweb',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/searcherxweb/',
  },
  {
    pattern: 'SearchExpress',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/searchexpress/',
  },
  {
    pattern: 'SecurityHeaders',
    additionDate: '2026/04/17',
    url: 'https://securityheaders.com/',
  },
  {
    pattern: 'semaltbot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/semaltbot/',
  },
  {
    pattern: 'SendGrid Event API',
    additionDate: '2026/04/17',
    url: 'https://sendgrid.com/docs/for-developers/tracking-events/event/',
  },
  {
    pattern: 'SentryUptimeBot\\/',
    additionDate: '2026/04/17',
    url: 'https://docs.sentry.io/product/alerts/uptime-monitoring/troubleshooting/#verify-firewall-configuration',
  },
  {
    pattern: 'seo-audit-check-bot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.webceo.com/webceo-bots.htm',
  },
  {
    pattern: 's4a\\/',
    additionDate: '2026/04/17',
    url: 'https://www.seo4ajax.com/',
  },
  {
    pattern: 'ClarityBot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.seoclarity.net/bot.html',
  },
  {
    pattern: 'SeoSiteCheckup',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/seositecheckup/',
  },
  {
    pattern: 'SeoulBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/seoulbot/',
  },
  {
    pattern: 'SERPtimizerBot',
    additionDate: '2026/04/17',
    url: 'http://serptimizer.com/serptimizer-bot',
  },
  {
    pattern: 'Server Density Service Monitoring',
    additionDate: '2026/04/17',
    url: 'https://www.stackpath.com/',
  },
  {
    pattern: 'ServerHunterSpider\\/',
    additionDate: '2026/04/17',
    url: 'https://www.serverhunter.com/',
  },
  {
    pattern: 'SeznamHomepageCrawler\\/',
    additionDate: '2026/04/17',
    url: 'http://napoveda.seznam.cz/en/seznambot-intro/',
  },
  {
    pattern: 'Shopify-Captain-Hook',
    additionDate: '2026/04/17',
    url: 'https://shopify.dev/docs/apps/build/webhooks',
  },
  {
    pattern: 'Shortwave Image Fetcher',
    additionDate: '2026/04/17',
    url: 'https://www.shortwave.com/',
  },
  {
    pattern: 'linkReader\\/',
    additionDate: '2026/04/17',
    url: 'https://sider.ai/',
  },
  {
    pattern: 'Sidetrade indexer bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/sidetrade-crawler/',
  },
  {
    pattern: 'Silk\\/',
    additionDate: '2026/04/17',
    url: 'https://www.useragentstring.com/pages/silk/',
  },
  {
    pattern: 'SinceraSyntheticUser\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/sincera-bot/',
  },
  {
    pattern: 'Optimizer\\)',
    additionDate: '2026/04/17',
    url: 'https://www.sistrix.com/faq/uptime',
  },
  {
    pattern: 'Site24x7',
    additionDate: '2026/04/17',
    url: 'https://www.site24x7.com/',
  },
  {
    pattern: 'SiteAuditBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/siteauditbot/',
  },
  {
    pattern: 'SiteCheck-sitecrawl',
    additionDate: '2026/04/17',
    url: 'https://support.siteimprove.com/hc/en-gb/articles/206345523-What-IP-addresses-and-user-agents-are-used-by-Siteimprove-',
  },
  {
    pattern: 'SiteScoreBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/sitescorebot/',
  },
  {
    pattern: 'SiteSearch360\\/',
    additionDate: '2026/04/17',
    url: 'https://www.sitesearch360.com/',
  },
  {
    pattern: 'SiteUptime\\.com',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/siteuptime-com/',
  },
  {
    pattern: 'Konturbot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/skb-kontur-bot/',
  },
  {
    pattern: 'SkroutzBot',
    additionDate: '2026/04/17',
    url: 'https://www.skroutz.gr/',
  },
  {
    pattern: 'SkyworkSpider',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/skyworkspider/',
  },
  {
    pattern: 'SlickBot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.slickstream.com/',
  },
  {
    pattern: 'SmartologyBot\\/',
    additionDate: '2026/04/17',
    url: 'https://smartology.net/smartologybot/',
  },
  {
    pattern: 'SnapURLPreview\\/',
    additionDate: '2026/04/17',
    url: 'https://business.snapchat.com/legal/snapchat-automated-crawler',
  },
  {
    pattern: 'SnapchatAds\\/',
    additionDate: '2026/04/17',
    url: 'https://businesshelp.snapchat.com/s/article/adsbot-crawler',
  },
  {
    pattern: 'Snipcart\\/',
    additionDate: '2026/04/17',
    url: 'https://snipcart.com/',
  },
  {
    pattern: 'solarwinds\\/',
    additionDate: '2026/04/17',
    url: 'https://documentation.solarwinds.com/en/success_center/observability/content/get-started/dem_getting_started_guide.htm',
  },
  {
    pattern: 'Sora POS\\/',
    additionDate: '2026/04/17',
    url: 'https://www.sora-caisse.com/sora.pdf',
  },
  {
    pattern: 'SparkShipping',
    additionDate: '2026/04/17',
    url: 'https://www.sparkshipping.com/',
  },
  {
    pattern: 'SparkPost',
    additionDate: '2026/04/17',
    url: 'https://www.sparkpost.com/',
  },
  {
    pattern: 'Spawning-AI',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/spawning-bot/',
  },
  {
    pattern: 'IDG\\/EU',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/spaziodati-bot/',
  },
  {
    pattern: 'Specificfeeds',
    additionDate: '2026/04/17',
    url: 'https://follow.it/',
  },
  {
    pattern: 'Spectate\\/',
    additionDate: '2026/04/17',
    url: 'https://docs.spectate.net/faq/uptime-monitor-bot',
  },
  {
    pattern: 'SpiderLing',
    additionDate: '2026/04/17',
    url: 'http://nlp.fi.muni.cz/projects/biwec/',
  },
  {
    pattern: 'splash Version\\/',
    additionDate: '2026/04/17',
    url: 'https://www.zyte.com/splash/',
  },
  {
    pattern: 'Rigor\\)',
    additionDate: '2026/04/17',
    url: 'https://www.splunk.com/',
  },
  {
    pattern: 'TwinWaveScanner',
    additionDate: '2026/04/17',
    url: 'https://www.splunk.com/en_us/products/attack-analyzer.html',
  },
  {
    pattern: 'SSL Labs \\(https:\\/\\/www\\.ssllabs\\.com',
    additionDate: '2026/04/17',
    url: 'https://www.ssllabs.com/',
  },
  {
    pattern: 'SSSSBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/ssssbot/',
  },
  {
    pattern: 'Stape\\/',
    additionDate: '2026/04/17',
    url: 'https://stape.io/helpdesk/documentation/stape-scanner',
  },
  {
    pattern: 'StartpagePrivateImageProxy\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/startpage-bot/',
  },
  {
    pattern: 'Statabot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.stata.com/support/statabot',
  },
  {
    pattern: 'StatistikAustria\\/',
    additionDate: '2026/04/17',
    url: 'https://www.statistik.at/ueber-uns/innovationen-und-experimentelle-statistik/einsatz-von-kassenscannerdaten-und-webscraping-in-der-preisstatistik',
  },
  {
    pattern: 'StatsDroneBot',
    additionDate: '2026/04/17',
    url: 'https://statsdrone.com/statsdrone-bot-documentation/',
  },
  {
    pattern: 'Stripe\\/',
    additionDate: '2026/04/17',
    url: 'https://stripe.com/docs/webhooks',
  },
  {
    pattern: 'Sucuri',
    additionDate: '2026/04/17',
    url: 'https://blog.sucuri.net/2012/10/ask-sucuri-how-does-sitecheck-work.html',
  },
  {
    pattern: 'Svix-Webhooks\\/',
    additionDate: '2026/04/17',
    url: 'https://docs.svix.com/receiving/source-ips',
  },
  {
    pattern: 'SwifteqLinkChecker',
    additionDate: '2026/04/17',
    url: 'https://www.swifteq.com/',
  },
  {
    pattern: 'Swisscows',
    additionDate: '2026/04/17',
    url: 'https://swisscows.com/',
  },
  {
    pattern: 'Datadog Synthetic',
    additionDate: '2026/04/17',
    url: 'https://docs.datadoghq.com/synthetics/',
  },
  {
    pattern: 'TactiScout\\/',
    additionDate: '2026/04/17',
    url: 'http://find-it.world/TempCrawl/Crawltheque.php',
  },
  {
    pattern: 'tchelebi\\/',
    additionDate: '2026/04/17',
    url: 'https://tchelebi.io/',
  },
  {
    pattern: 'bitdiscovery',
    additionDate: '2026/04/17',
    url: 'https://www.tenable.com/products/tenable-asm',
  },
  {
    pattern: 'Test Certificate Info',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/test-certificate-info/',
  },
  {
    pattern: 'Testcrawler',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/testcrawler/',
  },
  {
    pattern: 'test-bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/test-bot/',
  },
  {
    pattern: 'TestLocally\\/',
    additionDate: '2026/04/17',
    url: 'https://testlocal.ly/',
  },
  {
    pattern: 'TestURI',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/testuri-crawler/',
  },
  {
    pattern: 'TextRazor',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/textrazor-crawler/',
  },
  {
    pattern: 'The Knowledge AI',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/the-knowledge-ai/',
  },
  {
    pattern: 'TheInternetSearchx',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/theinternetsearch/',
  },
  {
    pattern: 'thesis-research-bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/thesis-research-bot/',
  },
  {
    pattern: 'Trellis-Services',
    additionDate: '2026/04/17',
    url: 'https://www.mediavine.com/',
  },
  {
    pattern: 'trentwil\\.es',
    additionDate: '2026/04/17',
    url: 'https://trentwil.es/domains.html',
  },
  {
    pattern: 'Trustly\\/',
    additionDate: '2026/04/17',
    url: 'https://www.trustly.net/',
  },
  {
    pattern: 'TTD-Content',
    additionDate: '2026/04/17',
    url: 'https://www.thetradedesk.com/us/ttd-content',
  },
  {
    pattern: 'Tweakers',
    additionDate: '2026/04/17',
    url: 'https://tweakers.net/',
  },
  {
    pattern: 'TwilioProxy\\/',
    additionDate: '2026/04/17',
    url: 'https://www.upday.com/',
  },
  {
    pattern: 'UASlinkChecker\\/',
    additionDate: '2026/04/17',
    url: 'https://udger.com/support/UASlinkChecker',
  },
  {
    pattern: 'hgfAlphaXCrawl\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/uni-passau_bot/',
  },
  {
    pattern: 'Unshorten\\.It\\!',
    additionDate: '2026/04/17',
    url: 'https://unshorten.it/',
  },
  {
    pattern: 'updown\\.io',
    additionDate: '2026/04/17',
    url: 'https://updown.io',
  },
  {
    pattern: 'Uptime\\/',
    additionDate: '2026/04/17',
    url: 'https://uptime.com/',
  },
  {
    pattern: 'uptimedoctor',
    additionDate: '2026/04/17',
    url: 'http://uptimestatistics.com/',
  },
  {
    pattern: 'Uptimia',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/uptimia/',
  },
  {
    pattern: 'uptrends',
    additionDate: '2026/04/17',
    url: 'https://www.uptrends.com/',
  },
  {
    pattern: 'Urlcheckr\\/',
    additionDate: '2026/04/17',
    url: 'https://www.urlcheckr.com/',
  },
  {
    pattern: 'URLSuMaBot',
    additionDate: '2026/04/17',
    url: 'https://www.urlsuma.de/bot.aspx',
  },
  {
    pattern: 'useeBookChecker\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/useebookchecker/',
  },
  {
    pattern: 'Vagabondo\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/vagabondo-bot/',
  },
  {
    pattern: 'VaultPress',
    additionDate: '2026/04/17',
    url: 'https://vaultpress.com/',
  },
  {
    pattern: 'videootvBot',
    additionDate: '2026/04/17',
    url: 'https://videoo.tv/',
  },
  {
    pattern: 'VsuSearchSpider\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/vsusearchspider/',
  },
  {
    pattern: 'vu-server-health-scanner\\/',
    additionDate: '2026/04/17',
    url: 'http://130.37.198.75/index.html',
  },
  {
    pattern: 'WARDBot\\/',
    additionDate: '2026/04/17',
    url: 'https://ward.ai/robot',
  },
  {
    pattern: 'WebsiteOps',
    additionDate: '2026/04/17',
    url: 'https://watchful.net/faqs/technical-support/how-do-i-whitelist-the-watchful-ip-address',
  },
  {
    pattern: 'WatchMouse',
    additionDate: '2026/04/17',
    url: 'https://asm.saas.broadcom.com/',
  },
  {
    pattern: 'Web Measure\\/',
    additionDate: '2026/04/17',
    url: 'https://webresearch.eecs.umich.edu/overview-of-web-measurements/',
  },
  {
    pattern: 'Webflow',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/webflow-bot/',
  },
  {
    pattern: 'webgains-bot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/webgains-bot/',
  },
  {
    pattern: 'webprosbot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/webprosbot/',
  },
  {
    pattern: 'websitepulse',
    additionDate: '2026/04/17',
    url: 'https://www.websitepulse.com/kb/websitepulse',
  },
  {
    pattern: 'WebSniffer\\/',
    additionDate: '2026/04/17',
    url: 'http://websniffer.com/',
  },
  {
    pattern: 'WSM\\/',
    additionDate: '2026/04/17',
    url: 'https://webspidermount.com/',
  },
  {
    pattern: 'WebwikiBot\\/',
    additionDate: '2026/04/17',
    url: 'https://www.webwiki.com/',
  },
  {
    pattern: 'WEDOS OnLine',
    additionDate: '2026/04/17',
    url: 'https://www.wedos.online',
  },
  {
    pattern: 'WhatsMyIP\\.org',
    additionDate: '2026/04/17',
    url: 'http://whatsmyip.org/ua',
  },
  {
    pattern: 'WhatWeb\\/',
    additionDate: '2026/04/17',
    url: 'https://www.whatweb.net/',
  },
  {
    pattern: 'Wheregoes\\.com',
    additionDate: '2026/04/17',
    url: 'https://wheregoes.com/',
  },
  {
    pattern: 'wheresitup\\.com\\/',
    additionDate: '2026/04/17',
    url: 'https://wheresitup.com/',
  },
  {
    pattern: 'Citoid',
    additionDate: '2026/04/17',
    url: 'https://www.mediawiki.org/wiki/Citoid',
  },
  {
    pattern: 'WireReaderBot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/wirereaderbot/',
  },
  {
    pattern: 'ZoteroTranslationServer\\/WMF',
    additionDate: '2026/04/17',
    url: 'https://wikitech.wikimedia.org/wiki/Zotero',
  },
  {
    pattern: 'wmtips\\.com\\/',
    additionDate: '2026/04/17',
    url: 'http://www.wmtips.com/tools/',
  },
  {
    pattern: 'WordCountBot\\/',
    additionDate: '2026/04/17',
    url: 'https://weglot.com/',
  },
  {
    pattern: 'Wordup-1',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/wordup-1/',
  },
  {
    pattern: 'workona-favicon-service\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/workona-bot/',
  },
  {
    pattern: 'Indy Library',
    additionDate: '2026/04/17',
    url: 'https://secure.ogone.com/',
  },
  {
    pattern: 'WJHRO\\/',
    additionDate: '2026/04/17',
    url: 'https://docs.worldpay.com/apis',
  },
  {
    pattern: 'WormlyBot',
    additionDate: '2026/04/17',
    url: 'https://www.wormly.com/help/server-monitoring/website',
  },
  {
    pattern: 'WovnCrawler\\/',
    additionDate: '2026/04/17',
    url: 'https://support.wovn.io/hc/ja/articles/360043165091',
  },
  {
    pattern: 'wowLink Crawler\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/wowlink-crawler/',
  },
  {
    pattern: 'WP Time Capsule',
    additionDate: '2026/04/17',
    url: 'https://docs.wptimecapsule.com/',
  },
  {
    pattern: 'WPUmbrella',
    additionDate: '2026/04/17',
    url: 'https://wp-umbrella.com/bot',
  },
  {
    pattern: 'wpbot\\/',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/wpbot/',
  },
  {
    pattern: 'WPMU DEV Broken Link Checker',
    additionDate: '2026/04/17',
    url: 'https://wpmudev.com/docs/hub-2-0/broken-link-checker-2/',
  },
  {
    pattern: 'WPMUDEV Uptime Monitor',
    additionDate: '2026/04/17',
    url: 'https://wpmudev.com/monitor/',
  },
  {
    pattern: 'WPSec\\/',
    additionDate: '2026/04/17',
    url: 'https://wpsec.com/',
  },
  {
    pattern: 'WRTNBot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/wrtnbot/',
  },
  {
    pattern: 'abuse\\.xmco\\.fr',
    additionDate: '2026/04/17',
    url: 'https://abuse.xmco.fr/',
  },
  {
    pattern: 'XY-Archive-Compliance',
    additionDate: '2026/04/17',
    url: 'https://xy-archive.helpscoutdocs.com/article/61-does-xy-archive-have-a-dedicated-ip-address',
  },
  {
    pattern: 'Yahoo Ad monitoring',
    additionDate: '2026/04/17',
    url: 'https://developer.yahoo.com/api/',
  },
  {
    pattern: 'YahooMailProxy',
    additionDate: '2026/04/17',
    url: 'https://help.yahoo.com/kb/yahoo-mail-proxy-SLN28749.html',
  },
  {
    pattern: 'YahooCacheSystem',
    additionDate: '2026/04/17',
    url: 'https://developer.yahoo.com/oauth2/guide/',
  },
  {
    pattern: 'YLT Chrome',
    additionDate: '2026/04/17',
    url: 'http://yellowlab.tools/',
  },
  {
    pattern: 'YokoyGroupAG\\/',
    additionDate: '2026/04/17',
    url: 'https://yokoy.io/',
  },
  {
    pattern: 'Yuuperbot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/yuuperbot/',
  },
  {
    pattern: 'Zapier',
    additionDate: '2026/04/17',
    url: 'https://zapier.com/',
  },
  {
    pattern: 'Zendesk Webhook',
    additionDate: '2026/04/17',
    url: 'https://support.zendesk.com/',
  },
  {
    pattern: 'Zombiebot\\/',
    additionDate: '2026/04/17',
    url: 'http://www.zombiedomain.net/robot/',
  },
  {
    pattern: 'zzhbot',
    additionDate: '2026/04/17',
    url: 'https://datadome.co/bots/zzhbot/',
  },
  {
    pattern: 'Penthouse Critical Path CSS Generator',
    additionDate: '2026/04/17',
    url: 'https://criticalcss.com/',
  },
  {
    pattern: 'Google-AdWords-Express',
    additionDate: '2026/04/17',
    url: 'https://developers.google.com/search/docs/crawling-indexing/google-user-triggered-fetchers#googleproducer',
  },
  {
    pattern: 'Notion\\/',
    additionDate: '2026/04/17',
    url: 'https://www.iubenda.com/',
  },
  {
    pattern: 'SSL Labs$',
    additionDate: '2026/04/17',
    url: 'https://www.qualys.com/apps/pci-compliance/',
  },
  {
    pattern: 'Skroutz ImageBot',
    additionDate: '2026/04/17',
    url: 'https://www.skroutz.gr/',
  },
  {
    pattern: 'Tumblr\\/',
    additionDate: '2026/04/17',
    url: 'https://automattic.com/',
  },
  {
    pattern: 'upday\\/',
    additionDate: '2026/04/17',
    url: 'https://www.upday.com/',
  },
  {
    pattern: 'watchTowr',
    additionDate: '2026/04/23',
    url: 'https://watchtowr.com',
  },
  {
    pattern: 'PRTG Network Monitor',
    additionDate: '2026/05/18',
    url: 'https://www.paessler.com/manuals/prtg/http_transaction_sensor',
  },
]);

/**
 * Substring case-insensitive match contro la lista canonical.
 * Ritorna primo pattern che matcha o null.
 */
export function isKnownCrawler(userAgent: string): KnownCrawler | null {
  if (!userAgent) return null;
  const ua = userAgent.toLowerCase();
  for (const c of KNOWN_CRAWLERS) {
    if (ua.includes(c.pattern.toLowerCase())) {
      return c;
    }
  }
  return null;
}
