const SHEET_NAME = "";
const PASSSLOT_API_KEY = "";
const TWILIO_SID = "";
const TWILIO_SECRET = "";

function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);

    switch (payload.type) {
      case "webhook.verify":
        return ContentService.createTextOutput(payload.data.token);
      case "pass.created":
        handlePassCreated(payload.data);
        break;
      default:
        handlePassUpdated(payload);
    }

    return ContentService.createTextOutput(
      JSON.stringify({
        success: true,
        message: "Webhook processed successfully",
      })
    ).setMimeType(ContentService.MimeType.JSON);
  } catch (error) {
    Logger.log("Error handling webhook: " + error.message);

    return ContentService.createTextOutput(
      JSON.stringify({ success: false, error: error.message })
    ).setMimeType(ContentService.MimeType.JSON);
  }
}

function handlePassCreated(data) {
  Logger.log("Pass created with data:", data);
}

function handlePassUpdated(payload) {
  const serialNumber = payload.data.passSerialNumber;
  const action = payload.data.action;
  const status = payload.data.status;
  const authorized = payload.data.authorized;
  if (action == "scan" && status == "valid" && authorized == true) {
    redeemCoupon(serialNumber);
  }
}

function doGet() {
  setupSheet();
  return HtmlService.createTemplateFromFile("Index")
    .evaluate()
    .setTitle("Coupon Generator")
    .addMetaTag("viewport", "width=device-width, initial-scale=1")
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function generateCoupon(data) {
  try {
    validateCouponData(data);

    const passData = {
      discount: data.discountAmount,
      service: data.serviceType,
      uses: data.maxUses === "unlimited" ? "∞" : data.maxUses,
      expiry: new Date(data.expirationDate).toLocaleDateString("en-GB"),
    };

    var PASSSLOT_TEMPLATE_ID = "6072470964666368";
    if (data.serviceType == "NYU Bookstore") {
      PASSSLOT_TEMPLATE_ID = "4574122667540480";
    } else if (data.serviceType == "Dining and Cafeteria") {
      PASSSLOT_TEMPLATE_ID = "5134508156387328";
    }

    const options = {
      method: "post",
      contentType: "application/json",
      headers: {
        Authorization:
          "Basic " + Utilities.base64Encode(PASSSLOT_API_KEY + ":"),
      },
      payload: JSON.stringify(passData),
    };

    const response = UrlFetchApp.fetch(
      `https://api.passslot.com/v1/templates/${PASSSLOT_TEMPLATE_ID}/pass`,
      options
    );

    const passInfo = JSON.parse(response.getContentText());

    const couponData = {
      name: data.name,
      email: data.email,
      serialNumber: passInfo.serialNumber,
      expirationDate: data.expirationDate,
      serviceType: data.serviceType,
      discount: data.discountAmount,
      maxUses: data.maxUses,
      remainingUses: data.maxUses === "unlimited" ? "unlimited" : data.maxUses,
      status: "active",
      passUrl: passInfo.url,
      qrCode: passInfo.url,
      createdAt: new Date().toISOString(),
    };

    logCouponToSheet(couponData);

    return {
      success: true,
      qrCodeUrl: passInfo.url,
      passUrl: passInfo.url,
    };
  } catch (error) {
    Logger.log("Error generating coupon: " + error);
    return {
      success: false,
      error: "Failed to generate coupon: " + error.message,
    };
  }
}

function validateCouponData(data) {
  const errors = [];

  if (!data.serviceType) errors.push("Service type is required");
  if (
    !data.discountAmount ||
    data.discountAmount < 1 ||
    data.discountAmount > 100
  ) {
    errors.push("Discount amount must be between 1 and 100");
  }
  if (!data.expirationDate || new Date(data.expirationDate) <= new Date()) {
    errors.push("Expiration date must be in the future");
  }
  if (!data.maxUses) errors.push("Number of uses is required");

  if (errors.length > 0) {
    throw new Error(errors.join(", "));
  }
}

function redeemCoupon(serialNumber) {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const data = sheet.getDataRange().getValues();
  const headers = data[0];
  const serialNumberCol = headers.indexOf("serialNumber");
  const remainingUsesCol = headers.indexOf("remainingUses");
  const emailCol = headers.indexOf("email");
  const statusCol = headers.indexOf("status");
  const passCol = headers.indexOf("passUrl");
  for (let i = 1; i < data.length; i++) {
    if (data[i][serialNumberCol] === serialNumber) {
      const remainingUses = data[i][remainingUsesCol];

      if (remainingUses === "unlimited") {
        activateCoupon(serialNumber, "valid");
        return { success: true, message: "Coupon redeemed successfully" };
      }

      const newUses = parseInt(remainingUses) - 1;
      if (newUses < 0) {
        return { success: false, error: "Coupon has no remaining uses" };
      }

      sheet.getRange(i + 1, remainingUsesCol + 1).setValue(newUses);

      if (newUses === 0) {
        sheet.getRange(i + 1, statusCol + 1).setValue("redeemed");
        updateCoupon(serialNumber, newUses);
        activateCoupon(serialNumber, "redeemed");
        sendNotification(data[i][emailCol], data[i][passCol]);
      } else {
        activateCoupon(serialNumber, "valid");
        updateCoupon(serialNumber, newUses);
      }

      return { success: true, message: "Coupon redeemed successfully" };
    }
  }

  return { success: false, error: "Coupon not found" };
}

function activateCoupon(serialNumber, status) {
  try {
    const data = {
      status: status,
    };

    const options = {
      method: "put",
      contentType: "application/json",
      headers: {
        Authorization:
          "Basic " + Utilities.base64Encode(PASSSLOT_API_KEY + ":"),
      },
      payload: JSON.stringify(data),
    };

    const response = UrlFetchApp.fetch(
      `https://api.passslot.com/v1/passes/pass.slot.coupon/${serialNumber}/status`,
      options
    );

    return {
      success: true,
      status: JSON.parse(response.getContentText()),
    };
  } catch (error) {
    Logger.log("Error activating coupon: " + error);
    return {
      success: false,
      error: "Failed to activate coupon: " + error.message,
    };
  }
}

function updateCoupon(serialNumber, uses) {
  try {
    const data = {
      uses: uses,
    };

    const options = {
      method: "put",
      contentType: "application/json",
      headers: {
        Authorization:
          "Basic " + Utilities.base64Encode(PASSSLOT_API_KEY + ":"),
      },
      payload: JSON.stringify(data),
    };

    const response = UrlFetchApp.fetch(
      `https://api.passslot.com/v1/passes/pass.slot.coupon/${serialNumber}/values`,
      options
    );

    return {
      success: true,
      status: JSON.parse(response.getContentText()),
    };
  } catch (error) {
    Logger.log("Error updating coupon: " + error);
    return {
      success: false,
      error: "Failed to update coupon: " + error.message,
    };
  }
}

function sendSMS(phoneNumber, passUrl) {
  try {
    const twilioEndpoint =
      "https://api.twilio.com/2010-04-01/Accounts/" +
      TWILIO_SID +
      "/Messages.json";

    const options = {
      method: "post",
      headers: {
        Authorization:
          "Basic " + Utilities.base64Encode(TWILIO_SID + ":" + TWILIO_SECRET),
      },
      payload: {
        To: phoneNumber,
        From: "+15555555555",
        Body: `Here's your coupon! Click to add to Apple Wallet: ${passUrl}`,
      },
    };

    UrlFetchApp.fetch(twilioEndpoint, options);
    return { success: true };
  } catch (error) {
    Logger.log("Error sending SMS: " + error);
    return { success: false, error: "Failed to send SMS" };
  }
}

function sendNotification(email, passUrl) {
  try {
    const subject = "Your Digital Coupon Has Been Redeemed";
    const body = `Your coupon has already been redeemed. Thank you for using our service! ${passUrl}`;

    GmailApp.sendEmail(email, subject, body);
    return { success: true };
  } catch (error) {
    Logger.log("Error sending email: " + error);
    return { success: false, error: "Failed to send email" };
  }
}

function sendEmail(email, passUrl) {
  try {
    const subject = "Your Digital Coupon";
    const body = `Here's your coupon! Click the following link to add it to Apple Wallet:\n\n${passUrl}`;

    GmailApp.sendEmail(email, subject, body);
    return { success: true };
  } catch (error) {
    Logger.log("Error sending email: " + error);
    return { success: false, error: "Failed to send email" };
  }
}

function setupSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);

  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    const headers = [
      "name",
      "email",
      "serialNumber",
      "expirationDate",
      "serviceType",
      "discount",
      "maxUses",
      "remainingUses",
      "status",
      "passUrl",
      "qrCode",
      "createdAt",
    ];

    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
    sheet.getRange(1, 1, 1, headers.length).setBackground("#f3f3f3");
  }
}

function logCouponToSheet(couponData) {
  const sheet =
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SHEET_NAME);
  const values = [
    couponData.name,
    couponData.email,
    couponData.serialNumber,
    couponData.expirationDate,
    couponData.serviceType,
    couponData.discount,
    couponData.maxUses,
    couponData.remainingUses,
    couponData.status,
    couponData.passUrl,
    couponData.qrCode,
    couponData.createdAt,
  ];

  sheet.appendRow(values);
}
