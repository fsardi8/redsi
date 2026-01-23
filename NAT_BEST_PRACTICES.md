# Redsi Network NAT Best Practices

## Summary
This document captures the NAT design pattern developed for casa router and applicable across all Redsi routers.

## Problem Solved
- VLAN2 (10.88.2.0/24) had no internet connectivity
- Root cause: Traffic routed via Alma uplink without NAT, Alma had no return route for 10.88.2.0/24
- Solution: Add uplink interfaces to WAN list, implement NAT with admin-network exclusion

## Design Principle

**Two categories of networks:**
1. **Client networks** (end-users, IoT): NAT all outbound traffic to preserve bandwidth and hide internal IPs
2. **Admin/IT networks** (management VLAN): Preserve source IPs for internal Redsi network access (SSH, Winbox, HTTP to routers), but NAT for internet

## Implementation Pattern

### 1. Interface Lists
```
/interface list member add list=WAN interface=vlan88.5-PtP       # Alma uplink
/interface list member add list=WAN interface=vlan10.5-publicas  # Azteca uplink (already there)
```

**Key principle:** All uplinks (primary + failover) should be in WAN list.

### 2. Address Lists (for flexibility)
```
/ip firewall address-list add list=private-nets address=10.0.0.0/8
/ip firewall address-list add list=private-nets address=172.16.0.0/12
/ip firewall address-list add list=private-nets address=192.168.0.0/16
```

These already exist on casa. Use them for the admin-network rule.

### 3. NAT Rules (srcnat chain)

**Rule order matters - process top to bottom. Two patterns apply depending on complexity:**

#### Basic Pattern (2-tier) - Simple scenarios

Use this when you have straightforward client and admin networks without specific hosts needing dedicated public IPs:

```
# Rule 1: Admin/IT network exception - no NAT to internal networks
chain=srcnat action=accept
    in-interface=vlan8.b-RedsiTec  # or whatever your admin VLAN is
    dst-address-list=private-nets
comment="Admin VLAN: preserve source to internal networks"

# Rule 2: Masquerade everything else to WAN
chain=srcnat action=masquerade
    out-interface-list=WAN
comment="NAT all outbound WAN traffic"
```

#### Advanced Pattern (3-tier) - Complex scenarios with specific hosts

Use this when you have hosts requiring dedicated public IPs (servers, cameras) or multiple admin networks:

```
# Tier 1: Specific host exceptions (1:1 NAT for dedicated public IPs)
chain=srcnat action=src-nat to-addresses=179.42.172.132
    src-address=10.48.48.100
    out-interface=vlan47.bWAN
comment="Fullcam server: 1:1 NAT to dedicated public IP"

# Tier 2: Admin network exceptions (preserve source to internal)
chain=srcnat action=accept
    in-interface=bridge-oficina
    dst-address-list=private-nets
comment="Admin network: preserve source to internal"

chain=srcnat action=accept
    src-address=10.88.88.0/24
    dst-address-list=private-nets
comment="Admin network 2: preserve source to internal"

# Tier 3: General NAT (everything else)
chain=srcnat action=src-nat to-addresses=179.42.172.2
    out-interface=vlan47.bWAN
comment="General NAT for client networks"
```

**Why rule order is critical:**
- Rules process top-to-bottom, first match wins
- Specific exceptions MUST come before broader rules
- If fullcam rule came after admin rule, fullcam would match the admin rule and get wrong NAT

### 4. Comments (Critical!)
Always comment NAT rules with:
- What traffic it affects
- Why (business logic)
- When it applies

Example:
```
"RedsiTec a Redsi sin NAT"     # What: RedsiTec→Redsi, Why: preserve IP for mgmt
"Admin VLAN: preserve source"   # Semantic, not technical
```

## Traffic Flow Logic

| Source Network | Destination | Outbound Interface | NAT Applied? | Why |
|---|---|---|---|---|
| vlan2/bridge (clients) | Internet | vlan10/vlan88 | ✓ Yes | Masquerade rule catches it |
| vlan8 (admin) | 10.0.0.0/8 (Redsi internal) | vlan10/vlan88 | ✗ No | Accepted by rule 1, preserves source IP for management |
| vlan8 (admin) | Internet (8.8.8.8) | vlan10/vlan88 | ✓ Yes | Falls through to masquerade rule |

## Advanced Patterns (Learned from VR Router)

### When to Use 3-Tier Pattern

Use the advanced 3-tier pattern when:

1. **Hosts need dedicated public IPs** (servers, cameras, API endpoints)
   - Examples: security cameras requiring external access, video streaming servers
   - Requires 1:1 NAT (srcnat + dstnat rules for bidirectional traffic)

2. **Multiple admin networks without dedicated interfaces**
   - Example: VPN tunnels, remote admin access, multiple management VLANs
   - Use `src-address=` matching instead of `in-interface=`

3. **Admin network contains special-case hosts**
   - Example: admin network (bridge-oficina) with fullcam server
   - Specific host rules must come BEFORE admin network rules

### Specific Host Exceptions (1:1 NAT)

When a host needs a dedicated public IP:

**Requirements:**
- One srcnat rule: `src-nat` to public IP (outbound traffic)
- One dstnat rule: `dst-nat` to private IP (inbound traffic)
- Both rules must reference the same IP pair
- srcnat rule MUST come before broader admin/client rules

**Example: Fullcam server**
```
# Outbound: fullcam traffic NATs to 179.42.172.132
chain=srcnat action=src-nat to-addresses=179.42.172.132
    src-address=10.48.48.100
    out-interface=vlan47.bWAN

# Inbound: traffic to .132 routes to fullcam
chain=dstnat action=dst-nat to-addresses=10.48.48.100
    dst-address=179.42.172.132
    protocol=!icmp
```

**Why BOTH rules are needed:**
- Without srcnat: fullcam's outbound packets exit with its private IP (doesn't reach internet)
- Without dstnat: inbound connections to .132 arrive at router, not fullcam
- Together they create a 1:1 NAT mapping: 10.48.48.100 ↔ 179.42.172.132

### Multiple Admin Networks

**Single admin VLAN with dedicated interface/bridge:**
```
chain=srcnat action=accept
    in-interface=bridge-oficina
    dst-address-list=private-nets
```
- Use `in-interface=` for clearer, interface-based policy
- Works well when admin network has its own bridge/VLAN

**Multiple admin networks without dedicated interfaces:**
```
chain=srcnat action=accept
    src-address=10.88.88.0/24
    dst-address-list=private-nets

chain=srcnat action=accept
    src-address=10.85.85.0/24
    dst-address-list=private-nets
```
- Use `src-address=` for flexibility across any interface
- Enables admin networks via VPN, tunnels, or remote connections
- Each admin network gets its own rule for clarity

**Mixed approach (VR pattern):**
```
# Local admin network via interface
chain=srcnat action=accept
    in-interface=bridge-oficina
    dst-address-list=private-nets

# Remote/VPN admin networks via source address
chain=srcnat action=accept
    src-address=10.88.88.0/24
    dst-address-list=private-nets
```

### In-Interface vs Src-Address Matching

| Scenario | Use | Example | Advantage |
|----------|-----|---------|-----------|
| Single admin VLAN on dedicated bridge/interface | `in-interface=` | `in-interface=bridge-oficina` | Clearer intent, interface-based policy |
| Multiple admin networks on different interfaces | `src-address=` with multiple rules | `src-address=10.88.88.0/24` | Explicit about which networks get exception |
| VPN/tunnel admin access (variable interface) | `src-address=` | `src-address=10.85.85.0/24` | Works regardless of which interface packet arrives on |
| Mixed: local + remote admin networks | Both | Local via `in-interface=`, remote via `src-address=` | Best of both approaches |

## Why Not OSPF Advertisement?

Initially considered advertising all local networks via OSPF, but decided against it because:
- Local client networks don't need to be reachable from upstream
- Reduces BGP/OSPF churn
- Simpler design: only advertise "public" Redsi network services
- Admin exclusion via NAT is cleaner than OSPF-only approach

## Casa Router Configuration (Final)

### Interfaces
```
vlan2.b-Alma         → 10.88.2.0/24 (VLAN2, clients)
vlan8.b-RedsiTec     → 10.88.88.0/24 (VLAN8, admin/IT)
bridge               → 10.88.0.0/24 (main LAN, clients)
vlan10.5-publicas    → WAN to Azteca ISP
vlan88.5-PtP         → WAN to Alma router (uplink)
```

### WAN List Members
- vlan10.5-publicas Azteca (ISP)
- ether5-WAN (backup WAN)
- vlan88.5-PtP (Alma uplink)

### NAT Rules
1. `accept in-interface=vlan8.b-RedsiTec dst-address-list=private-nets` (preserve IP to internal)
2. `masquerade out-interface-list=WAN` (NAT everything else)

## VR Router Configuration (Reference - 3-Tier Pattern)

### Scenario
- Multiple admin networks with different configurations
- Special host (fullcam) requiring dedicated public IP within admin network
- Primary WAN via PtP uplink to Borde router

### Networks
```
bridge-oficina (admin IT network)  → 10.48.48.0/24
10.88.88.0/24 (remote admin)       → Via VPN/tunnel
10.85.85.0/24 (remote admin)       → Via VPN/tunnel
vlan47.bWAN (WAN)                  → To Borde uplink
```

### Special Case: Fullcam Server
```
Private IP: 10.48.48.100 (within bridge-oficina)
Public IP:  179.42.172.132 (dedicated 1:1 NAT)
Purpose:    Security camera server requiring external access
```

### NAT Rules (3-Tier with srcnat and dstnat)

**Srcnat chain (outbound):**
```
# Tier 1: Specific host exceptions
chain=srcnat action=src-nat to-addresses=179.42.172.132
    src-address=10.48.48.100
    out-interface=vlan47.bWAN
comment="Fullcam server: 1:1 NAT to dedicated public IP"

# Tier 2: Admin network exceptions (preserve source to internal)
chain=srcnat action=accept
    in-interface=bridge-oficina
    dst-address-list=private-nets
comment="Admin network bridge-oficina: preserve source to internal"

chain=srcnat action=accept
    src-address=10.88.88.0/24
    dst-address-list=private-nets
comment="Admin network 10.88.88.0/24: preserve source to internal"

chain=srcnat action=accept
    src-address=10.85.85.0/24
    dst-address-list=private-nets
comment="Admin network 10.85.85.0/24: preserve source to internal"

# Tier 3: General NAT (everything else to public IP)
chain=srcnat action=src-nat to-addresses=179.42.172.2
    out-interface=vlan47.bWAN
comment="General NAT for client networks"
```

**Dstnat chain (inbound):**
```
chain=dstnat action=dst-nat to-addresses=10.48.48.100
    dst-address=179.42.172.132
    protocol=!icmp
comment="Fullcam inbound: route to private IP"
```

### Traffic Flow Examples

| Source | Destination | Rule Hit | Result | Reason |
|--------|-------------|----------|--------|--------|
| 10.48.48.100 (fullcam) | 8.8.8.8 (internet) | Tier 1 | NAT to 179.42.172.132 | Specific host exception |
| 10.48.48.50 (bridge-oficina) | 10.230.88.5 (internal) | Tier 2 | Preserve source 10.48.48.50 | Admin network exception |
| 10.48.48.50 (bridge-oficina) | 8.8.8.8 (internet) | Tier 3 | NAT to 179.42.172.2 | Falls through to general NAT |
| 10.88.88.5 (admin VPN) | 10.230.88.5 (internal) | Tier 2 | Preserve source 10.88.88.5 | Admin network exception |
| 10.88.88.5 (admin VPN) | 8.8.8.8 (internet) | Tier 3 | NAT to 179.42.172.2 | Falls through to general NAT |
| External → 179.42.172.132 | Inbound connection | Dstnat | Routes to 10.48.48.100 | Fullcam 1:1 NAT |

### Why This Pattern Works

**Tier 1 (Specific hosts):** Fullcam rule matches before admin rule, ensuring it gets dedicated IP even though it's in bridge-oficina.

**Tier 2 (Admin networks):** Three separate rules handle different admin networks consistently—each preserves source to internal, but Internet-bound traffic falls through to Tier 3.

**Tier 3 (General NAT):** Catches all remaining traffic (clients and admin Internet access), NATs to single gateway IP for bandwidth efficiency.

**Critical ordering:** If Tier 2 came before Tier 1, fullcam would match the admin exception rule and get the wrong NAT IP.

## Testing

### Basic Pattern (2-tier)
```
# Client network - should have internet
/ping 8.8.8.8 src-address=10.88.2.1

# Admin network - should have internet with NAT
/ping 8.8.8.8 src-address=10.88.88.1

# Admin to internal - should preserve source IP
/ping 10.230.88.0 src-address=10.88.88.1

# Check translation tracking
/ip firewall connection print
```

### Advanced Pattern (3-tier with specific hosts)
```
# Specific host outbound - check source IP is dedicated public IP
/ping 8.8.8.8 src-address=10.48.48.100
# Expected: source appears as 179.42.172.132 at destination

# Specific host to internal - should preserve source
/ping 10.230.88.0 src-address=10.48.48.100
# Expected: appears as 10.48.48.100

# Inbound to specific host public IP - should reach private IP
/ping 10.48.48.100 src-address=<external>
# Expected: ICMP blocked by dstnat (protocol=!icmp)
# But TCP/UDP connections should work

# Admin network behavior - same as basic pattern
/ping 10.230.88.0 src-address=10.48.48.50
# Expected: appears as 10.48.48.50

# Check NAT mappings
/ip firewall nat print numbers
/ip firewall connection print where dst-address=179.42.172.132
```

## Applying to Other Routers (vr, sama, etc.)

### Step 1: Assess Your Network

**Do you have hosts needing dedicated public IPs?**
- Servers requiring external access
- Security cameras with public streaming
- API endpoints accessed externally
- If YES → use 3-tier pattern; if NO → use 2-tier pattern

**How many admin networks?**
- Single admin VLAN → use `in-interface=`
- Multiple admin networks → use `src-address=` for each

### Step 2: Basic Setup

1. **Identify admin VLAN(s)** (usually the Redsi IT/management network)
2. **Add uplinks to WAN list**
   - Primary uplink interface
   - Failover uplink interface (if present)
3. **Create private-nets address-list** (if not present)
   ```
   /ip firewall address-list add list=private-nets address=10.0.0.0/8
   /ip firewall address-list add list=private-nets address=172.16.0.0/12
   /ip firewall address-list add list=private-nets address=192.168.0.0/16
   ```

### Step 3: Add NAT Rules

**For simple networks (2-tier):**
```
# Rule N: Admin exception
chain=srcnat action=accept
    in-interface=<your-admin-vlan>
    dst-address-list=private-nets

# Rule N+1: General NAT
chain=srcnat action=masquerade
    out-interface-list=WAN
```

**For complex networks (3-tier with specific hosts):**
```
# Rule N: Specific host exception (if needed)
chain=srcnat action=src-nat to-addresses=<public-ip>
    src-address=<private-ip>
    out-interface=<uplink>
chain=dstnat action=dst-nat to-addresses=<private-ip>
    dst-address=<public-ip>
    protocol=!icmp

# Rule N+1: Admin network(s)
chain=srcnat action=accept
    in-interface=<admin-vlan>  # or src-address=<admin-network>
    dst-address-list=private-nets

# Rule N+2: General NAT
chain=srcnat action=src-nat to-addresses=<gateway-ip>
    out-interface=<uplink>
```

### Step 4: Document and Test

1. **Document with clear comments** - What, Why, When
2. **Test each tier:**
   - Specific host outbound (if applicable)
   - Admin to internal (should preserve source)
   - Admin to internet (should NAT)
   - Client to internet (should NAT)
3. **Verify with `/ip firewall nat print numbers`**
4. **Check active connections with `/ip firewall connection print`**

## Common Mistakes to Avoid

### Basic Pattern Mistakes

❌ **Wrong:** `accept in-interface=vlan8 out-interface=!vlan10`
- Breaks internet access to RedsiTec via Alma (no NAT for internet-bound traffic)

✓ **Right:** `accept in-interface=vlan8 dst-address-list=private-nets`
- Only skips NAT for internal destinations
- Internet-bound traffic falls through to masquerade

❌ **Wrong:** Not adding uplinks to WAN list
- Masquerade rule won't apply to uplink traffic
- No NAT on client networks using that uplink

✓ **Right:** All uplinks in WAN list
- Single masquerade rule works for all exits

### Advanced Pattern Mistakes

❌ **Wrong:** Specific host exception AFTER admin network rule
```
chain=srcnat action=accept
    in-interface=bridge-oficina
    dst-address-list=private-nets

chain=srcnat action=src-nat to-addresses=179.42.172.132
    src-address=10.48.48.100
    out-interface=vlan47.bWAN
```
- Fullcam hits admin rule first, matches and stops processing
- Never reaches specific host rule
- Results in wrong NAT IP (general NAT instead of dedicated IP)

✓ **Right:** Specific host exception BEFORE admin network rule
```
chain=srcnat action=src-nat to-addresses=179.42.172.132
    src-address=10.48.48.100
    out-interface=vlan47.bWAN

chain=srcnat action=accept
    in-interface=bridge-oficina
    dst-address-list=private-nets
```
- Fullcam hits specific rule first (1:1 NAT applied)
- Other bridge-oficina hosts hit admin rule (source preserved to internal)

❌ **Wrong:** Only srcnat without matching dstnat for specific host
```
chain=srcnat action=src-nat to-addresses=179.42.172.132 src-address=10.48.48.100
# Missing dstnat rule!
```
- Outbound traffic works (goes to public IP)
- Inbound connections to public IP don't reach the server
- 1:1 NAT is asymmetrical and broken

✓ **Right:** Both srcnat and dstnat for 1:1 NAT
```
chain=srcnat action=src-nat to-addresses=179.42.172.132 src-address=10.48.48.100
chain=dstnat action=dst-nat to-addresses=10.48.48.100 dst-address=179.42.172.132
```
- Outbound and inbound both work
- Bidirectional 1:1 NAT is complete

❌ **Wrong:** Multiple admin networks with wrong matching
```
chain=srcnat action=accept
    in-interface=bridge-oficina
    dst-address-list=private-nets
# This only works for bridge-oficina!
# Remote 10.88.88 traffic via tunnel won't match in-interface
```
- Remote admin access breaks
- Remote admins get NAT to internet instead of source preservation

✓ **Right:** Use src-address for remote/multi-interface admin networks
```
chain=srcnat action=accept
    in-interface=bridge-oficina
    dst-address-list=private-nets

chain=srcnat action=accept
    src-address=10.88.88.0/24
    dst-address-list=private-nets
```
- Works regardless of which interface packet arrives on
- Remote admin networks get correct source preservation

## Status (2026-01-23)

### Casa Router (2-tier pattern)
✓ VLAN2 (Alma) connectivity fixed
✓ VLAN8 (RedsiTec) preserves source IPs to internal network
✓ Client networks get NATted
✓ Failover routing (Azteca ISP) works
✓ Pattern documented for application to other routers

### VR Router (3-tier pattern)
✓ Multiple admin networks (bridge-oficina, 10.88.88, 10.85.85)
✓ Fullcam server with dedicated 1:1 NAT to 179.42.172.132
✓ Specific host exceptions rule correctly ordered before admin exceptions
✓ Mixed scenario (admin network containing special-case host) working
✓ Traffic flow verified for all tiers
✓ Advanced pattern documented with decision guidance

### Documentation Updates
✓ Implementation pattern expanded with basic (2-tier) and advanced (3-tier) examples
✓ Advanced Patterns section added covering specific hosts, multiple networks, matching methods
✓ VR router reference configuration added with complete rule set and traffic flow examples
✓ Testing procedures expanded for both patterns
✓ Application guidance updated with step-by-step implementation
✓ Common mistakes section expanded with 3-tier pattern issues and solutions
