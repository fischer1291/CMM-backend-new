const { Expo } = require("expo-server-sdk");
const apn = require("node-apn");
const User = require("../models/User");
const PushTicket = require("../models/PushTicket");

const expo = new Expo({
  accessToken: process.env.EXPO_ACCESS_TOKEN, // Optional but recommended
  useFcmV1: true, // Use the newer FCM v1 API
});

// VoIP push configuration
// One provider per APNs environment: development builds get sandbox tokens,
// TestFlight/App Store/ad-hoc builds get production tokens.
const voipProviders = { production: null, sandbox: null };
const VOIP_TOPIC = process.env.VOIP_TOPIC || "com.schly21.kontaktlisteapp.voip";

// Initialize VoIP push provider (iOS only)
function initializeVoipPush() {
  try {
    // Check if VoIP credentials are available
    if (
      process.env.VOIP_KEY_CONTENT &&
      process.env.VOIP_KEY_ID &&
      process.env.VOIP_TEAM_ID
    ) {
      const token = {
        key: process.env.VOIP_KEY_CONTENT.replace(/\\n/g, "\n"),
        keyId: process.env.VOIP_KEY_ID,
        teamId: process.env.VOIP_TEAM_ID,
      };
      voipProviders.production = new apn.Provider({ token, production: true });
      voipProviders.sandbox = new apn.Provider({ token, production: false });

      console.log("✅ VoIP push providers initialized (production + sandbox)");
      console.log("   - Environment:", process.env.NODE_ENV);
      console.log("   - Key ID:", process.env.VOIP_KEY_ID);
      console.log("   - Team ID:", process.env.VOIP_TEAM_ID);
    } else {
      console.log("⚠️ VoIP push not configured - missing credentials");
      console.log(
        "   - VOIP_KEY_CONTENT:",
        process.env.VOIP_KEY_CONTENT ? "Set" : "Missing",
      );
      console.log(
        "   - VOIP_KEY_ID:",
        process.env.VOIP_KEY_ID ? "Set" : "Missing",
      );
      console.log(
        "   - VOIP_TEAM_ID:",
        process.env.VOIP_TEAM_ID ? "Set" : "Missing",
      );
    }
  } catch (error) {
    console.error("❌ Failed to initialize VoIP push:", error.message);
  }
}


/**
 * Send VoIP push notification for incoming call
 */
async function sendVoipPushNotification(
  callerPhone,
  calleePhone,
  channel,
  callerName,
  callId,
) {
  try {
    console.log(`📞 Attempting VoIP push: ${callerPhone} -> ${calleePhone}`);

    // Get callee's VoIP token
    const calleeUser = await User.findOne({ phone: calleePhone });
    if (!calleeUser || !calleeUser.voipToken) {
      console.log(`❌ No VoIP token found for user: ${calleePhone}`);
      return false;
    }

    // If VoIP is not configured, return false to fall back to regular push
    if (!voipProviders.production) {
      console.log(
        "⚠️ VoIP provider not configured, falling back to regular push",
      );
      return false;
    }

    const voipToken = calleeUser.voipToken;

    const buildNotification = () => {
      const notification = new apn.Notification();
      // VoIP notifications use a special topic: bundle ID + .voip
      notification.topic = VOIP_TOPIC;
      notification.pushType = "voip";
      // The app reports this to CallKit natively (AppDelegate.swift); callId
      // must match the socket event so both paths show the same call.
      notification.payload = {
        callId,
        callerPhone,
        calleePhone,
        channel,
        callerName: callerName || callerPhone,
        hasVideo: true,
        timestamp: Date.now(),
      };
      notification.priority = 10;
      notification.expiry = Math.floor(Date.now() / 1000) + 30;
      return notification;
    };

    // Try the environment that worked last time first; a token from the other
    // environment is rejected with BadDeviceToken.
    const known = calleeUser.voipTokenMetadata?.environment;
    const environments =
      known === "sandbox" ? ["sandbox", "production"] : ["production", "sandbox"];

    for (const environment of environments) {
      const result = await voipProviders[environment].send(
        buildNotification(),
        voipToken,
      );

      if (result.sent && result.sent.length > 0) {
        if (known !== environment) {
          await User.updateOne(
            { phone: calleePhone },
            { "voipTokenMetadata.environment": environment },
          );
        }
        console.log(`✅ VoIP push sent (${environment}) to: ${calleePhone}`);
        return true;
      }

      const failure = result.failed && result.failed[0];
      const reason = failure?.response?.reason;
      console.error(`❌ VoIP push failed (${environment}):`, reason || failure?.error);

      if (reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic") {
        continue; // wrong environment, try the other one
      }

      // 410 Unregistered: the token is no longer valid
      if (String(failure?.status) === "410" || reason === "Unregistered") {
        await User.updateOne(
          { phone: calleePhone },
          { $unset: { voipToken: 1, voipTokenMetadata: 1 } },
        );
        console.log(`🧹 Removed invalid VoIP token for user: ${calleePhone}`);
      }
      return false;
    }

    return false;
  } catch (error) {
    console.error("❌ Error sending VoIP push:", error);
    return false;
  }
}

/**
 * Enhanced push notification sending with proper error handling
 */
async function sendEnhancedCallNotification(
  callerPhone,
  calleePhone,
  channel,
  callerName,
  callId,
) {
  try {
    console.log(
      `📞 Sending enhanced call notification: ${callerPhone} -> ${calleePhone}`,
    );

    // Get callee's push token
    const calleeUser = await User.findOne({ phone: calleePhone });
    if (!calleeUser || !calleeUser.pushToken) {
      console.log(`❌ No push token found for user: ${calleePhone}`);
      return false;
    }

    const pushToken = calleeUser.pushToken;

    // Validate push token
    if (!Expo.isExpoPushToken(pushToken)) {
      console.log(`❌ Invalid push token for user: ${calleePhone}`);
      return false;
    }

    // Expo's message format: channel, category and iOS interruption level
    // are top-level fields. No badge: a call is not an unread item.
    const message = {
      to: pushToken,
      sound: "default",
      title: `📞 ${callerName || "Unbekannt"}`,
      body: "Videoanruf",
      data: {
        type: "incoming_call",
        callId,
        callerPhone,
        calleePhone,
        channel,
        callerName: callerName || callerPhone,
        hasVideo: true,
        timestamp: Date.now(),
      },
      categoryId: "incoming_call",
      channelId: "incoming-calls",
      priority: "high",
      interruptionLevel: "time-sensitive",
      // A call nobody answered in 30 s is over
      ttl: 30,
    };

    const [ticket] = await sendExpoPushes([message]);
    if (!ticket || ticket.status !== "ok") {
      console.error("❌ Call notification ticket error:", ticket?.message);
      return false;
    }

    console.log(
      `✅ Enhanced call notification sent successfully to: ${calleePhone}`,
    );
    return true;
  } catch (error) {
    console.error("❌ Error in sendEnhancedCallNotification:", error);
    return false;
  }
}

/**
 * Send call end notification
 */
async function sendCallEndNotification(from, to, channel) {
  try {
    const calleeUser = await User.findOne({ phone: to });
    if (!calleeUser || !calleeUser.pushToken) return;

    // Silent: wakes the app so it can stop ringing, shows nothing
    const message = {
      to: calleeUser.pushToken,
      data: { type: "call_ended", channel, from },
      priority: "high",
      _contentAvailable: true,
      ttl: 60,
    };

    await sendExpoPushes([message]);
    console.log(`📞 Call end notification sent to: ${to}`);
  } catch (error) {
    console.error("❌ Error sending call end notification:", error);
  }
}

/**
 * Send Expo push messages in chunks. Drops tokens Expo reports as
 * DeviceNotRegistered. Returns the tickets.
 */
async function sendExpoPushes(messages) {
  const valid = messages.filter((m) => Expo.isExpoPushToken(m.to));
  const tickets = [];
  for (const chunk of expo.chunkPushNotifications(valid)) {
    try {
      const chunkTickets = await expo.sendPushNotificationsAsync(chunk);
      const pending = [];
      chunkTickets.forEach((ticket, i) => {
        tickets.push(ticket);
        if (ticket.status === "ok" && ticket.id) {
          // Delivery problems only show up in the receipt (lib/receipts.js)
          pending.push({ ticketId: ticket.id, token: chunk[i].to, type: chunk[i].data?.type });
        } else if (ticket.status === "error" && ticket.details?.error === "DeviceNotRegistered") {
          User.updateOne({ pushToken: chunk[i].to }, { $unset: { pushToken: 1 } }).catch(() => {});
        }
      });
      if (pending.length) {
        await PushTicket.insertMany(pending, { ordered: false }).catch(() => {});
      }
    } catch (error) {
      console.error("❌ Error sending push chunk:", error);
    }
  }
  return tickets;
}

module.exports = {
  Expo,
  expo,
  initializeVoipPush,
  voipProviders,
  sendVoipPushNotification,
  sendEnhancedCallNotification,
  sendCallEndNotification,
  sendExpoPushes,
};
