import dns from 'node:dns';

/**
 * Atlas `mongodb+srv://` URIs need SRV and TXT DNS lookups. Node does those
 * with its own resolver (c-ares), which fails (querySrv ETIMEOUT/ECONNREFUSED)
 * on machines whose default DNS server refuses those queries, as some
 * Windows/ISP setups do.
 * Point it at public resolvers so the lookup always works.
 *
 * Only `dns.resolve*` uses these servers. Ordinary hostname lookups
 * (getaddrinfo), such as Docker service names, still use the system resolver.
 *
 * Override with DNS_SERVERS=1.1.1.1,1.0.0.1 in the real environment, or
 * DNS_SERVERS=system to keep the OS resolver. Runs before .env is loaded, so
 * a value in .env is not read here.
 */
const servers = (process.env.DNS_SERVERS ?? '8.8.8.8,8.8.4.4,1.1.1.1')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

if (servers[0] !== 'system') dns.setServers(servers);
dns.setDefaultResultOrder('ipv4first');
