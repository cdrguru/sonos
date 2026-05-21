# Technical Reference Manual: Sonos Smart Speaker Controller

This technical reference manual serves as the comprehensive, production-ready specification for implementing a local-first Smart Speaker Controller application. The documentation establishes a protocol-level engineering guide, detailing the discovery sequences, control schemas, cloud APIs, and synchronisation state machines required to interface with the hardware ecosystem.

---

## Zone 1: Network Discovery Architecture & Payloads

The local network discovery layer uses a dual-protocol configuration consisting of Simple Service Discovery Protocol (SSDP) and Multicast DNS (mDNS). While SSDP is the primary mechanism used to locate active speakers on the local subnet, mDNS provides an alternative Link-Local lookup interface.

### Multicast Network Configurations

The controller application must open UDP sockets bound to the specific multicast IP addresses and port numbers listed below. The application must listen for incoming unicast responses as well as periodic unsolicited device notification broadcasts.

| Protocol | Multicast IP Address | UDP Port | Target Service Identifier / Name |
| :--- | :--- | :--- | :--- |
| **SSDP** | `239.255.255.250` | `1900` | `urn:schemas-upnp-org:device:ZonePlayer:1` |
| **mDNS** | `224.0.0.251` | `5353` | `_sonos._tcp.local` |

### The Wire Format: SSDP M-SEARCH Payload

To initiate device discovery, the controller must broadcast a raw UDP payload using the HTTP/1.1-like SSDP M-SEARCH format. Each header line must terminate with a carriage return and line feed (`\r\n`), and the packet must conclude with an empty line to conform to UPnP standard wire specifications.

```http
M-SEARCH * HTTP/1.1
HOST: 239.255.255.250:1900
MAN: "ssdp:discover"
MX: 1
ST: urn:schemas-upnp-org:device:ZonePlayer:1
```

When a speaker receives this broadcast, it responds with a unicast UDP packet to the sender's origin port, containing the absolute URL of its device description document.

```http
HTTP/1.1 200 OK
CACHE-CONTROL: max-age = 1800
EXT:
LOCATION: http://192.168.1.100:1400/xml/device_description.xml
SERVER: Linux UPnP/1.0 Sonos/80.1-56190 (ZP120)
ST: urn:schemas-upnp-org:device:ZonePlayer:1
USN: uuid:RINCON_000E58A1B2C301400::urn:schemas-upnp-org:device:ZonePlayer:1
X-RINCON-HOUSEHOLD: Sonos_830xqkNC8tdUFBVuv1GRd8ueGd
X-RINCON-BOOTSEQ: 49
BOOTID.UPNP.ORG: 49
X-RINCON-WIFIMODE: 0
X-RINCON-VARIANT: 2
HOUSEHOLD.SMARTSPEAKER.AUDIO: Sonos_830xqkNC8tdUFBVuv1GRd8ueGd.Ys3JvtobjY3KA44qJIWH
```

In addition to explicit search queries, active speakers periodically advertise their availability on the network using SSDP `NOTIFY` broadcasts.

```http
NOTIFY * HTTP/1.1
HOST: 239.255.255.250:1900
CACHE-CONTROL: max-age = 1800
LOCATION: http://192.168.1.100:1400/xml/device_description.xml
NT: upnp:rootdevice
NTS: ssdp:alive
USN: uuid:RINCON_000E58A1B2C301400::upnp:rootdevice
```

### Parsing Logic for Device XML Description

Once the controller extracts the URI from the `LOCATION` header, it executes an HTTP GET request to retrieve the XML device description metadata. The retrieved XML document contains hardware-level properties necessary to identify individual speakers, display names, and network interfaces.

```xml
<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>
    <friendlyName>192.168.1.100 - Sonos Play:1</friendlyName>
    <manufacturer>Sonos, Inc.</manufacturer>
    <manufacturerURL>http://www.sonos.com</manufacturerURL>
    <modelNumber>S1</modelNumber>
    <modelDescription>Sonos Play:1</modelDescription>
    <modelName>Sonos Play:1</modelName>
    <modelURL>http://www.sonos.com/products/zoneplayers/S1</modelURL>
    <softwareVersion>80.1-56190</softwareVersion>
    <swGen>2</swGen>
    <hardwareVersion>1.8.3.7-2.0</hardwareVersion>
    <serialNum>00-0E-58-A1-B2-C3:A</serialNum>
    <MACAddress>00:0E:58:A1:B2:C3</MACAddress>
    <UDN>uuid:RINCON_000E58A1B2C301400</UDN>
    <iconList>
      <icon>
        <id>0</id>
        <mimetype>image/png</mimetype>
        <width>48</width>
        <height>48</height>
        <depth>24</depth>
        <url>/img/icon-S1.png</url>
      </icon>
    </iconList>
    <minCompatibleVersion>79.0-00000</minCompatibleVersion>
    <legacyCompatibleVersion>58.0-00000</legacyCompatibleVersion>
    <apiVersion>1.41.4</apiVersion>
    <minApiVersion>1.1.0</minApiVersion>
    <displayVersion>16.3.3</displayVersion>
    <roomName>Living Room</roomName>
    <displayName>Play:1</displayName>
    <zoneType>9</zoneType>
  </device>
</root>
```

To extract target player configurations from the XML document, the parsing engine must execute XPath queries or standard DOM parsing logic to extract the element values detailed in the following schema mapping.

| Target Property | Parsing Source Path | Purpose |
| :--- | :--- | :--- |
| `roomName` | `/root/device/roomName/text()` | Identifies the user-assigned name of the room. |
| `displayName` | `/root/device/displayName/text()` | Specifies the hardware model name of the physical speaker unit. |
| `macAddress` | `/root/device/MACAddress/text()` | Identifies the unique hardware MAC address of the player's primary network card. |
| `udn` | `/root/device/UDN/text()` | Provides the unique identifier for target grouping, formatted as `uuid:RINCON_<MAC>01400`. |

---

## Zone 2: Local UPnP / SOAP API Schema Spec

The local LAN control interface uses synchronous UPnP SOAP commands over TCP port 1400. Commands are sent as HTTP POST requests to specified control endpoints.

### API Service Mapping and Endpoints

Each UPnP service on the speaker handles a specific set of controls and exposes a designated endpoint path.

| Service Name | Control Endpoint Path | Target Actions |
| :--- | :--- | :--- |
| `AVTransport:1` | `/MediaRenderer/AVTransport/Control` | Handles playback, transport controls, and grouping operations. |
| `RenderingControl:1` | `/MediaRenderer/RenderingControl/Control` | Controls volume, relative volume adjustments, and muting states. |
| `ZoneGroupTopology:1` | `/ZoneGroupTopology/Control` | Tracks network topology, active groups, and device associations. |

### Complete SOAP Request Specifications

The following payloads represent complete, production-ready XML schemas and HTTP wrappers. These wrappers must be transmitted with exact headers, matching the `Content-Type` and `SOAPAction` specifications to avoid server rejection errors.

#### 1. AVTransport:1 - Play
Starts or resumes audio playback on the target group coordinator.

```http
POST /MediaRenderer/AVTransport/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 326
SOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#Play"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Play xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <Speed>1</Speed>
    </u:Play>
  </s:Body>
</s:Envelope>
```

#### 2. AVTransport:1 - Pause
Pauses audio playback on the target group coordinator.

```http
POST /MediaRenderer/AVTransport/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 298
SOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#Pause"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Pause xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Pause>
  </s:Body>
</s:Envelope>
```

#### 3. AVTransport:1 - Stop
Stops audio playback on the target group coordinator.

```http
POST /MediaRenderer/AVTransport/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 296
SOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#Stop"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Stop xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Stop>
  </s:Body>
</s:Envelope>
```

#### 4. AVTransport:1 - Next
Skips to the next track in the playback queue.

```http
POST /MediaRenderer/AVTransport/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 296
SOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#Next"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:Next xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
    </u:Next>
  </s:Body>
</s:Envelope>
```

#### 5. AVTransport:1 - SetAVTransportURI
Sets the primary media URI or links a player to a group coordinator using its unique identifier.

```http
POST /MediaRenderer/AVTransport/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 727
SOAPAction: "urn:schemas-upnp-org:service:AVTransport:1#SetAVTransportURI"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetAVTransportURI xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
      <InstanceID>0</InstanceID>
      <CurrentURI>x-file-cifs://nas/music/track1.mp3</CurrentURI>
      <CurrentURIMetaData>&lt;DIDL-Lite xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot; xmlns:upnp=&quot;urn:schemas-upnp-org:metadata-1-0/upnp/&quot; xmlns:r=&quot;urn:schemas-rinconnetworks-com:metadata-1-0/&quot; xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot;&gt;&lt;item id=&quot;f1&quot; parentID=&quot;0&quot; restricted=&quot;true&quot;&gt;&lt;dc:title&gt;Track1&lt;/dc:title&gt;&lt;upnp:class&gt;object.item.audioItem.musicTrack&lt;/upnp:class&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;</CurrentURIMetaData>
    </u:SetAVTransportURI>
  </s:Body>
</s:Envelope>
```

#### 6. RenderingControl:1 - GetVolume
Queries the current volume level of a physical player on a scale from 0 to 100.

```http
POST /MediaRenderer/RenderingControl/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 326
SOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#GetVolume"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
    </u:GetVolume>
  </s:Body>
</s:Envelope>
```

#### 7. RenderingControl:1 - SetVolume
Sets the volume of a physical player to a specific target level.

```http
POST /MediaRenderer/RenderingControl/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 341
SOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#SetVolume"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetVolume xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
      <DesiredVolume>45</DesiredVolume>
    </u:SetVolume>
  </s:Body>
</s:Envelope>
```

#### 8. RenderingControl:1 - GetMute
Queries the active muting state (0 for unmuted, 1 for muted) of a physical player.

```http
POST /MediaRenderer/RenderingControl/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 322
SOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#GetMute"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
    </u:GetMute>
  </s:Body>
</s:Envelope>
```

#### 9. RenderingControl:1 - SetMute
Mutes or unmutes a physical player.

```http
POST /MediaRenderer/RenderingControl/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 335
SOAPAction: "urn:schemas-upnp-org:service:RenderingControl:1#SetMute"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:SetMute xmlns:u="urn:schemas-upnp-org:service:RenderingControl:1">
      <InstanceID>0</InstanceID>
      <Channel>Master</Channel>
      <DesiredMute>1</DesiredMute>
    </u:SetMute>
  </s:Body>
</s:Envelope>
```

#### 10. ZoneGroupTopology:1 - GetZoneGroupState
Queries the player to discover all active group configurations, coordinators, and member players.

```http
POST /ZoneGroupTopology/Control HTTP/1.1
Host: 192.168.1.100:1400
Content-Type: text/xml; charset="utf-8"
Content-Length: 310
SOAPAction: "urn:schemas-upnp-org:service:ZoneGroupTopology:1#GetZoneGroupState"
Connection: close

<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetZoneGroupState xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"/>
  </s:Body>
</s:Envelope>
```

### Topology Decoding and JSON Tree Construction

The string returned by `GetZoneGroupState` is a serialized XML payload wrapped inside a standard SOAP envelope. The application must decode this escaped XML string and parse it to build a clean JSON representation of the network topology.

#### Escaped XML inside SOAP Response Payload

```xml
<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:GetZoneGroupStateResponse xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1">
      <ZoneGroupState>&lt;ZoneGroupState&gt;&lt;ZoneGroups&gt;&lt;ZoneGroup Coordinator=&quot;RINCON_000E58A1B2C301400&quot; ID=&quot;RINCON_000E58A1B2C301400:509930175&quot;&gt;&lt;ZoneGroupMember UUID=&quot;RINCON_000E58A1B2C301400&quot; Location=&quot;http://192.168.1.100:1400/xml/device_description.xml&quot; ZoneName=&quot;Living Room&quot; Icon=&quot;&quot; Configuration=&quot;1&quot; SoftwareVersion=&quot;80.1-56190&quot; SWGen=&quot;2&quot; MinCompatibleVersion=&quot;70.0-00000&quot; LegacyCompatibleVersion=&quot;58.0-00000&quot; BootSeq=&quot;4&quot; TVConfigurationError=&quot;0&quot; HdmiCecAvailable=&quot;1&quot; WirelessMode=&quot;0&quot;/&gt;&lt;ZoneGroupMember UUID=&quot;RINCON_542A1B5D6A7001400&quot; Location=&quot;http://192.168.1.105:1400/xml/device_description.xml&quot; ZoneName=&quot;Kitchen&quot; Icon=&quot;&quot; Configuration=&quot;1&quot; SoftwareVersion=&quot;80.1-56190&quot; SWGen=&quot;2&quot; MinCompatibleVersion=&quot;70.0-00000&quot; LegacyCompatibleVersion=&quot;58.0-00000&quot; BootSeq=&quot;5&quot; TVConfigurationError=&quot;0&quot; HdmiCecAvailable=&quot;0&quot; WirelessMode=&quot;0&quot;/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;&lt;/ZoneGroupState&gt;</ZoneGroupState>
    </u:GetZoneGroupStateResponse>
  </s:Body>
</s:Envelope>
```

#### Decoded Topology XML Tree

After converting the HTML entities, the inner `<ZoneGroupState>` tag exposes a structured hierarchy of active groups and speakers.

```xml
<ZoneGroupState>
  <ZoneGroups>
    <ZoneGroup Coordinator="RINCON_000E58A1B2C301400" ID="RINCON_000E58A1B2C301400:509930175">
      <ZoneGroupMember UUID="RINCON_000E58A1B2C301400" Location="http://192.168.1.100:1400/xml/device_description.xml" ZoneName="Living Room" Icon="" Configuration="1" SoftwareVersion="80.1-56190" SWGen="2" MinCompatibleVersion="70.0-00000" LegacyCompatibleVersion="58.0-00000" BootSeq="4" TVConfigurationError="0" HdmiCecAvailable="1" WirelessMode="0"/>
      <ZoneGroupMember UUID="RINCON_542A1B5D6A7001400" Location="http://192.168.1.105:1400/xml/device_description.xml" ZoneName="Kitchen" Icon="" Configuration="1" SoftwareVersion="80.1-56190" SWGen="2" MinCompatibleVersion="70.0-00000" LegacyCompatibleVersion="58.0-00000" BootSeq="5" TVConfigurationError="0" HdmiCecAvailable="0" WirelessMode="0"/>
    </ZoneGroup>
  </ZoneGroups>
</ZoneGroupState>
```

#### Decoded Target JSON Tree Structure

To map this layout to the application UI, the parsing engine converts the XML data into a normalized, structured JSON tree. This structure categorizes speakers into coordinators (primary nodes managing the playback queue) and group members (secondary nodes playing synchronized audio).

```json
{
  "coordinators": [
    {
      "uuid": "RINCON_000E58A1B2C301400",
      "groupId": "RINCON_000E58A1B2C301400:509930175",
      "roomName": "Living Room",
      "location": "http://192.168.1.100:1400/xml/device_description.xml",
      "members": [
        {
          "uuid": "RINCON_542A1B5D6A7001400",
          "roomName": "Kitchen",
          "location": "http://192.168.1.105:1400/xml/device_description.xml"
        }
      ]
    }
  ]
}
```

### Large-Scale Subnet Fallback Mechanism

On networks with more than 20 players, executing a synchronous SOAP request for `GetZoneGroupState` often fails with a `UPnPError 501 (Action failed)` error. The physical driver boards in the hardware contain a restricted 16KB XML buffer allocated for synchronous SOAP responses. When the generated serialization payload exceeds this 16KB ceiling, the internal service drops the transaction and returns the 501 fault.

To mitigate this constraint, the local controller application must use an event-driven fallback strategy:

1. **Inhibit Synchronous Pull Requests:** Inhibit standard polling of `GetZoneGroupState` on discovered nodes.
2. **Establish Event Subscription:** Execute a General Event Notification Architecture (GENA) subscription targeting the `/ZoneGroupTopology/Event` subscription path on individual players.
3. **Handle Event Subscriptions:** The GENA subscription is established using the standard HTTP `SUBSCRIBE` method.

```http
SUBSCRIBE /ZoneGroupTopology/Event HTTP/1.1
Host: 192.168.1.100:1400
CALLBACK: <http://192.168.1.150:8080/events/topology>
NT: upnp:event
TIMEOUT: Second-1800
```

The speaker confirms the subscription and responds with a subscription ID (SID). The speaker then pushes asynchronous, event-driven state chunks to the designated callback port whenever topology structures change. Because these event messages are split into smaller payloads, they bypass the 16KB hardware limit and prevent 501 errors in large smart home environments.

---

## Zone 3: Modern Sonos Control Cloud API & WebSocket Schemas

The modern control layer routes commands through the cloud-based API endpoint at `api.ws.sonos.com` using secure WAN protocols.

### Transport Specifications

All cloud communications run over HTTPS (for REST commands) and Secure WebSockets (for asynchronous event subscriptions). Incoming REST operations require an OAuth2 Bearer Access Token included in the HTTP headers.

```http
Authorization: Bearer us_oauth_token_73d2a091e98bc0098f42bc83c401ee0a
Content-Type: application/json
Accept: application/json
```

Requests are routed using dedicated paths designed to isolate households, groups, or individual players:

* **Household Namespace:** POST `https://api.ws.sonos.com/control/api/v1/households/{householdId}/groups/createGroup`
* **Group Volume Namespace:** POST `https://api.ws.sonos.com/control/api/v1/groups/{groupId}/groupVolume`
* **Player Volume Namespace:** POST `https://api.ws.sonos.com/control/api/v1/players/{playerId}/playerVolume`

### JSON Schemas

The schemas below represent complete, cut-and-pasteable JSON objects for group and volume operations.

#### Create Group Request Schema
Creates a synchronized playback group using a list of unique player IDs.

```json
{
  "playerIds": [
    "RINCON_000E58A1B2C301400",
    "RINCON_542A1B5D6A7001400"
  ]
}
```

#### Create Group Response Schema (200 OK)
Returns details about the created group, including the designated coordinator and current playback status.

```json
{
  "group": {
    "id": "RINCON_000E58A1B2C301400:509930175",
    "name": "Living Room + Kitchen",
    "coordinatorId": "RINCON_000E58A1B2C301400",
    "playbackState": "PLAYBACK_STATE_IDLE",
    "playerIds": [
      "RINCON_000E58A1B2C301400",
      "RINCON_542A1B5D6A7001400"
    ]
  }
}
```

#### Set Group Volume Request Schema
Sets the target volume for the entire group, adjusting individual player levels proportionally to preserve their relative balance.

```json
{
  "volume": 45
}
```

#### Set Group Volume Response Schema (200 OK)
```json
{}
```

### Eventing Model: WebSocket Notification Payload Structure

When the controller application subscribes to active event streams, the server pushes asynchronous updates to the client whenever playback or volume conditions change.

#### Playback Namespace Event Payload
Reports the state of the media player, details about the active track, queue versions, and available player controls.

```json
{
  "namespace": "playback",
  "event": "playbackStatus",
  "groupId": "RINCON_000E58A1B2C301400:509930175",
  "body": {
    "playbackState": "PLAYBACK_STATE_PLAYING",
    "positionMillis": 45200,
    "itemId": "guid_track_783190ab7cde893112",
    "queueVersion": "q_v12_98ac7d3bf",
    "previousItemId": "guid_track_783190ab7cde893111",
    "previousPositionMillis": 184000,
    "playModes": {
      "repeat": false,
      "repeatOne": false,
      "crossfade": true,
      "shuffle": false
    },
    "availablePlaybackActions": {
      "canSkip": true,
      "canSkipBack": true,
      "canSeek": true,
      "canPause": true,
      "canStop": true,
      "canRepeat": true,
      "canRepeatOne": true,
      "canCrossfade": true,
      "canShuffle": true
    }
  }
}
```

#### Group Volume Namespace Event Payload
Notifies clients of changes to the group's volume level, muting state, or structural limitations.

```json
{
  "namespace": "groupVolume",
  "event": "groupVolume",
  "groupId": "RINCON_000E58A1B2C301400:509930175",
  "body": {
    "volume": 45,
    "muted": false,
    "fixed": false
  }
}
```

---

## Zone 4: Sub-100ms CRDT Local Sync State Machine

To deliver a highly responsive local-first user interface, slider adjustments should render instantly. The local UI should register changes immediately without waiting for a hardware network confirmation loop. This requires an optimistic synchronization model that reconciles conflicting state changes locally.

### State Machine Conflict Resolution

Let the local state record of the client controller at timestamp $t$ be represented by the tuple:

$$S_t = \langle V_t, \Phi_t, L_t, \Sigma_t \rangle$$

where:
* $V_t \in [0, 100]$ is the active displayed volume level of the group.
* $\Phi_t \in \{ \text{CONFIRMED}, \text{PENDING} \}$ is the synchronization phase of the state variable.
* $L_t \in \mathbb{R}^+$ is the local Unix epoch timestamp in milliseconds of the last user interaction.
* $\Sigma_t \in \mathbb{N}$ is the sequence identifier tracking incoming hardware events (`X-RINCON-BOOTSEQ` or sequential UPnP integers).

When a user interacts with the UI slider at timestamp $t_0$, the controller initiates a state transition to update the optimistic volume $v$:

$$S_{t_0} = \langle v, \text{PENDING}, t_0, \Sigma_{t_{\text{prev}}} \rangle$$

Let $E_{\text{net}} = \langle v', t_1, \sigma, e_{\text{corr}} \rangle$ represent an incoming network event from a speaker node reporting volume level $v'$ with sequence number $\sigma$ arriving at timestamp $t_1$. Let $\Delta$ represent the temporal lockout threshold (configured to $800 \text{ ms}$).

The state machine resolves conflicts using the following logic matrix:

$$S_{t_1} = \begin{cases} \langle v', \text{CONFIRMED}, L_{t_0}, \sigma \rangle, & \text{if } \Phi_{t_0} = \text{CONFIRMED} \land \sigma \ge \Sigma_{t_0} \\ \langle v', \text{CONFIRMED}, L_{t_0}, \sigma \rangle, & \text{if } \Phi_{t_0} = \text{PENDING} \land ((t_1 - t_0 \ge \Delta) \lor e_{\text{corr}} = \text{true}) \\ S_{t_0}, & \text{otherwise} \end{cases}$$

This logic enforces three behaviors:

1. **Passive Synchronization:** While the local state is `CONFIRMED`, any fresh incoming state with a newer sequence number immediately updates the UI.
2. **Active Input Lockout:** While a user is actively adjusting a volume slider, the local state transitions to `PENDING`. The state machine ignores any incoming network updates that arrive within the temporal window ($\Delta = 800\text{ ms}$). This prevents visual "slider bounce" if other network events arrive mid-gesture.
3. **Optimistic Expiry:** If the inhibition window expires without a local confirmation, the state machine yields to the speaker’s hardware state. This prevents the controller from falling permanently out of sync.

### The Ghost Indicator Rule

The application's global store must isolate optimistic user states from confirmed hardware states. This separation enables the UI to render "ghost indicator" states, such as a semi-transparent or pulsating slider handle, indicating to the user that a local volume change is pending hardware confirmation.

The state tracking model is structured using the following schema:

```typescript
export interface SpeakerVolumeState {
  playerId: string;
  confirmedVolume: number;
  optimisticVolume: number;
  syncState: 'DRAFT' | 'PENDING' | 'CONFIRMED';
  lastLocalWriteTime: number;
  lastSequenceId: number;
  pendingCorrelationId: string | null;
}
```

* If `syncState` is `CONFIRMED`, the slider handle renders solidly at `confirmedVolume`.
* If `syncState` is `PENDING`, the slider handle renders at `optimisticVolume` using a semi-transparent or pulsing "ghost" style. Once the matching hardware ACK is received, the slider transitions back to `CONFIRMED` styling.

### State Engine Implementation

```typescript
export class LocalFirstSyncEngine {
  private state: SpeakerVolumeState;
  private readonly LOCKOUT_WINDOW_MS = 800;

  constructor(initialPlayerId: string, initialVolume: number) {
    this.state = {
      playerId: initialPlayerId,
      confirmedVolume: initialVolume,
      optimisticVolume: initialVolume,
      syncState: 'CONFIRMED',
      lastLocalWriteTime: 0,
      lastSequenceId: 0,
      pendingCorrelationId: null
    };
  }

  public getDisplayVolume(): number {
    if (this.state.syncState === 'PENDING') {
      return this.state.optimisticVolume;
    }
    return this.state.confirmedVolume;
  }

  public isOptimisticPending(): boolean {
    return this.state.syncState === 'PENDING';
  }

  public registerUserInteraction(targetVolume: number, correlationId: string): void {
    const epochTimeNow = Date.now();
    this.state.optimisticVolume = targetVolume;
    this.state.syncState = 'PENDING';
    this.state.lastLocalWriteTime = epochTimeNow;
    this.state.pendingCorrelationId = correlationId;
  }

  public receiveHardwareUpdate(
    reportedVolume: number,
    sequenceId: number,
    correlationId: string | null
  ): void {
    const epochTimeNow = Date.now();

    if (this.state.syncState === 'PENDING') {
      const isMatchingCorrelation = 
        correlationId !== null && 
        this.state.pendingCorrelationId === correlationId;

      const windowHasExpired = 
        (epochTimeNow - this.state.lastLocalWriteTime) >= this.LOCKOUT_WINDOW_MS;

      if (isMatchingCorrelation || windowHasExpired) {
        this.state.confirmedVolume = reportedVolume;
        this.state.syncState = 'CONFIRMED';
        this.state.pendingCorrelationId = null;
        this.state.lastSequenceId = sequenceId;
      }
    } else {
      if (sequenceId >= this.state.lastSequenceId) {
        this.state.confirmedVolume = reportedVolume;
        this.state.lastSequenceId = sequenceId;
      }
    }
  }

  public getRawState(): Readonly<SpeakerVolumeState> {
    return { ...this.state };
  }
}
```

This state synchronization engine ensures that physical speaker adjustments from other network controllers are eventually reconciled. Simultaneously, it isolates active local user adjustments, preventing incoming network latency from degrading the local UI experience.
