/**
 * Batch 3 web-extraction tests — HLS/DASH/Video/RSS/Sitemap.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { hlsProbeNode } from './hls-probe.js';
import { dashProbeNode } from './dash-probe.js';
import { videoMetadataNode } from './video-metadata.js';
import { rssFeedTriggerNode } from './rss-feed.js';
import { sitemapCrawlerNode } from './sitemap-crawler.js';

const CTX = { tenantId: 't', workflowId: 'w', runId: 'r', nodeId: 'n', secrets: {} } as never;
const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.MEDEA_FFPROBE_ENDPOINT;
});

describe('action_hls_probe', () => {
  it('throw se url mancante', async () => {
    await expect(hlsProbeNode.executor!({}, null, CTX)).rejects.toThrow(/url required/);
  });

  it('master playlist → ritorna varianti con bandwidth + resolution', async () => {
    const master = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=854x480,CODECS="avc1.4d401e,mp4a.40.2"
720p.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3500000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2"
1080p.m3u8`;
    global.fetch = vi.fn(
      async () =>
        new Response(master, {
          status: 200,
          headers: { 'content-type': 'application/vnd.apple.mpegurl' },
        }),
    );
    const r = await hlsProbeNode.executor!({ url: 'https://cdn.x/master.m3u8' }, null, CTX);
    const out = r.output as { type: string; variants: { bandwidth: number; resolution: string }[] };
    expect(out.type).toBe('master');
    expect(out.variants.length).toBe(2);
    expect(out.variants[0]!.bandwidth).toBe(1280000);
    expect(out.variants[1]!.resolution).toBe('1920x1080');
  });

  it('media playlist → segmenti con durata', async () => {
    const media = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-MEDIA-SEQUENCE:0
#EXTINF:10.0,
segment0.ts
#EXTINF:10.0,
segment1.ts
#EXT-X-ENDLIST`;
    global.fetch = vi.fn(async () => new Response(media, { status: 200 }));
    const r = await hlsProbeNode.executor!({ url: 'https://cdn.x/media.m3u8' }, null, CTX);
    const out = r.output as {
      type: string;
      segments: { duration: number }[];
      totalDuration: number;
      targetDuration: number;
      endlist: boolean;
    };
    expect(out.type).toBe('media');
    expect(out.segments.length).toBe(2);
    expect(out.totalDuration).toBe(20);
    expect(out.targetDuration).toBe(10);
    expect(out.endlist).toBe(true);
  });

  it('non-m3u8 → throw "Not a valid HLS"', async () => {
    global.fetch = vi.fn(async () => new Response('<html>not hls</html>', { status: 200 }));
    await expect(
      hlsProbeNode.executor!({ url: 'https://x.io/page.html' }, null, CTX),
    ).rejects.toThrow(/Not a valid HLS/);
  });
});

describe('action_dash_probe', () => {
  it('throw se url mancante', async () => {
    await expect(dashProbeNode.executor!({}, null, CTX)).rejects.toThrow(/url required/);
  });

  it('manifest valido → ritorna adaptation sets video+audio', async () => {
    const mpd = `<?xml version="1.0"?>
<MPD type="static" mediaPresentationDuration="PT1H30M" minBufferTime="PT2S" profiles="urn:mpeg:dash:profile:isoff-on-demand:2011">
  <Period>
    <AdaptationSet id="0" contentType="video" mimeType="video/mp4">
      <Representation id="v1" bandwidth="800000" width="640" height="360" codecs="avc1.42c01e"/>
      <Representation id="v2" bandwidth="2000000" width="1280" height="720" codecs="avc1.4d401f"/>
    </AdaptationSet>
    <AdaptationSet id="1" contentType="audio" mimeType="audio/mp4" lang="it">
      <Representation id="a1" bandwidth="128000" codecs="mp4a.40.2" audioSamplingRate="48000"/>
    </AdaptationSet>
  </Period>
</MPD>`;
    global.fetch = vi.fn(
      async () =>
        new Response(mpd, { status: 200, headers: { 'content-type': 'application/dash+xml' } }),
    );
    const r = await dashProbeNode.executor!({ url: 'https://cdn.x/movie.mpd' }, null, CTX);
    const out = r.output as {
      type: string;
      totalDurationSec: number;
      counts: { videoSets: number; audioSets: number; totalRepresentations: number };
    };
    expect(out.type).toBe('static');
    expect(out.totalDurationSec).toBe(5400); // 1h30m
    expect(out.counts.videoSets).toBe(1);
    expect(out.counts.audioSets).toBe(1);
    expect(out.counts.totalRepresentations).toBe(3);
  });
});

describe('action_video_metadata', () => {
  it('throw se endpoint mancante', async () => {
    await expect(videoMetadataNode.executor!({ url: 'https://x.mp4' }, null, CTX)).rejects.toThrow(
      /ffprobe endpoint not configured/,
    );
  });

  it('throw se url+dataBase64 entrambi vuoti', async () => {
    process.env.MEDEA_FFPROBE_ENDPOINT = 'http://ffp.local:8080';
    await expect(videoMetadataNode.executor!({}, null, CTX)).rejects.toThrow(
      /url or dataBase64 required/,
    );
  });

  it('happy path: estrai convenience fields da ffprobe response', async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            format: {
              duration: '60.5',
              bit_rate: '5000000',
              format_name: 'mov,mp4,m4a',
              size: '37000000',
            },
            streams: [
              {
                codec_type: 'video',
                codec_name: 'h264',
                width: 1920,
                height: 1080,
                r_frame_rate: '25/1',
              },
              { codec_type: 'audio', codec_name: 'aac', tags: { language: 'ita' } },
              { codec_type: 'audio', codec_name: 'aac', tags: { language: 'eng' } },
              { codec_type: 'subtitle', tags: { language: 'ita' } },
            ],
          }),
          { status: 200 },
        ),
    );
    const r = await videoMetadataNode.executor!(
      {
        endpoint: 'http://ffp.local:8080',
        url: 'https://x.mp4',
      },
      null,
      CTX,
    );
    const out = r.output as {
      duration: number;
      videoCodec: string;
      videoWidth: number;
      audioTracks: number;
      audioLanguages: string[];
      subtitleTracks: number;
    };
    expect(out.duration).toBe(60.5);
    expect(out.videoCodec).toBe('h264');
    expect(out.videoWidth).toBe(1920);
    expect(out.audioTracks).toBe(2);
    expect(out.audioLanguages).toEqual(['ita', 'eng']);
    expect(out.subtitleTracks).toBe(1);
  });
});

describe('trigger_rss_feed', () => {
  it('throw se url mancante', async () => {
    await expect(rssFeedTriggerNode.executor!({}, null, CTX)).rejects.toThrow(/url required/);
  });

  it('parse RSS 2.0 → items con title+link+publishedAt ISO', async () => {
    const rss = `<?xml version="1.0"?>
<rss version="2.0">
  <channel>
    <title>My Blog</title>
    <link>https://blog.io</link>
    <item>
      <guid>post-1</guid>
      <title>Post numero 1</title>
      <link>https://blog.io/p1</link>
      <description>Descrizione</description>
      <pubDate>Wed, 28 May 2026 10:00:00 GMT</pubDate>
      <author>mario@blog.io</author>
    </item>
    <item>
      <guid>post-2</guid>
      <title>Post numero 2</title>
      <link>https://blog.io/p2</link>
      <pubDate>Thu, 29 May 2026 10:00:00 GMT</pubDate>
    </item>
  </channel>
</rss>`;
    global.fetch = vi.fn(
      async () =>
        new Response(rss, { status: 200, headers: { 'content-type': 'application/rss+xml' } }),
    );
    const r = await rssFeedTriggerNode.executor!({ url: 'https://blog.io/feed.xml' }, null, CTX);
    const out = r.output as {
      format: string;
      feedTitle: string;
      itemsCount: number;
      items: { title: string; publishedAt: string }[];
    };
    expect(out.format).toBe('rss');
    expect(out.feedTitle).toBe('My Blog');
    expect(out.itemsCount).toBe(2);
    expect(out.items[0]!.title).toBe('Post numero 1');
    expect(out.items[0]!.publishedAt).toMatch(/2026-05-28/);
  });

  it('parse Atom 1.0 → items con id+title+link href', async () => {
    const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Feed</title>
  <link href="https://atom.io"/>
  <entry>
    <id>tag:1</id>
    <title>Entry uno</title>
    <link href="https://atom.io/e1"/>
    <updated>2026-05-30T10:00:00Z</updated>
    <author><name>Anna</name></author>
  </entry>
</feed>`;
    global.fetch = vi.fn(
      async () =>
        new Response(atom, { status: 200, headers: { 'content-type': 'application/atom+xml' } }),
    );
    const r = await rssFeedTriggerNode.executor!({ url: 'https://atom.io/feed' }, null, CTX);
    const out = r.output as {
      format: string;
      itemsCount: number;
      items: { title: string; link: string }[];
    };
    expect(out.format).toBe('atom');
    expect(out.itemsCount).toBe(1);
    expect(out.items[0]!.link).toBe('https://atom.io/e1');
  });

  it('filtro sinceIso → solo items più recenti', async () => {
    const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>X</title>
  <item><guid>1</guid><title>Old</title><link>/o</link><pubDate>Wed, 01 May 2026 00:00:00 GMT</pubDate></item>
  <item><guid>2</guid><title>New</title><link>/n</link><pubDate>Wed, 30 May 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;
    global.fetch = vi.fn(async () => new Response(rss, { status: 200 }));
    const r = await rssFeedTriggerNode.executor!(
      {
        url: 'https://blog.io/feed.xml',
        sinceIso: '2026-05-15T00:00:00Z',
      },
      null,
      CTX,
    );
    const out = r.output as { itemsCount: number; items: { title: string }[] };
    expect(out.itemsCount).toBe(1);
    expect(out.items[0]!.title).toBe('New');
  });
});

describe('action_sitemap_crawler', () => {
  it('throw se url mancante', async () => {
    await expect(sitemapCrawlerNode.executor!({}, null, CTX)).rejects.toThrow(/url required/);
  });

  it('sitemap urlset diretto → ritorna URL', async () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.io/p1</loc><lastmod>2026-05-01</lastmod></url>
  <url><loc>https://x.io/p2</loc><lastmod>2026-05-30</lastmod></url>
</urlset>`;
    global.fetch = vi.fn(
      async () =>
        new Response(xml, { status: 200, headers: { 'content-type': 'application/xml' } }),
    );
    const r = await sitemapCrawlerNode.executor!({ url: 'https://x.io/sitemap.xml' }, null, CTX);
    const out = r.output as {
      totalUrlsInSitemap: number;
      filteredCount: number;
      urls: { loc: string }[];
    };
    expect(out.totalUrlsInSitemap).toBe(2);
    expect(out.filteredCount).toBe(2);
    expect(out.urls[0]!.loc).toBe('https://x.io/p1');
  });

  it('filtro includeRegex applicato', async () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.io/blog/post1</loc></url>
  <url><loc>https://x.io/products/item1</loc></url>
  <url><loc>https://x.io/blog/post2</loc></url>
</urlset>`;
    global.fetch = vi.fn(async () => new Response(xml, { status: 200 }));
    const r = await sitemapCrawlerNode.executor!(
      {
        url: 'https://x.io/sitemap.xml',
        includeRegex: '/blog/',
      },
      null,
      CTX,
    );
    const out = r.output as { filteredCount: number; urls: { loc: string }[] };
    expect(out.filteredCount).toBe(2);
    expect(out.urls.every((u) => u.loc.includes('/blog/'))).toBe(true);
  });

  it('filtro lastmodSinceIso → solo URL aggiornati dopo', async () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://x.io/old</loc><lastmod>2026-01-01</lastmod></url>
  <url><loc>https://x.io/new</loc><lastmod>2026-05-30</lastmod></url>
</urlset>`;
    global.fetch = vi.fn(async () => new Response(xml, { status: 200 }));
    const r = await sitemapCrawlerNode.executor!(
      {
        url: 'https://x.io/sitemap.xml',
        lastmodSinceIso: '2026-05-01',
      },
      null,
      CTX,
    );
    const out = r.output as { filteredCount: number; urls: { loc: string }[] };
    expect(out.filteredCount).toBe(1);
    expect(out.urls[0]!.loc).toBe('https://x.io/new');
  });
});

describe('Batch 3 — def metadata', () => {
  const all = [
    hlsProbeNode,
    dashProbeNode,
    videoMetadataNode,
    rssFeedTriggerNode,
    sitemapCrawlerNode,
  ];

  it('tutti hanno description > 100 char', () => {
    for (const node of all) {
      expect(node.def.description.length).toBeGreaterThan(100);
    }
  });

  it('tutti hanno configFields con help inline', () => {
    for (const node of all) {
      const fields = node.def.configFields ?? [];
      expect(fields.length).toBeGreaterThan(0);
      expect(fields.filter((f) => f.help && f.help.length > 10).length).toBeGreaterThan(0);
    }
  });

  it('rss-feed e\\` type=trigger, gli altri type=action', () => {
    expect(rssFeedTriggerNode.def.type).toBe('trigger');
    expect(hlsProbeNode.def.type).toBe('action');
    expect(dashProbeNode.def.type).toBe('action');
    expect(videoMetadataNode.def.type).toBe('action');
    expect(sitemapCrawlerNode.def.type).toBe('action');
  });
});
