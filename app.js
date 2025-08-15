// โหลด environment variables
require("dotenv").config();

const express = require("express");
const line = require("@line/bot-sdk");
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const app = express();

// ตั้งค่า LINE Bot
const config = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

const client = new line.Client(config);

// สร้างโฟลเดอร์ uploads หากยังไม่มี
if (!fs.existsSync("uploads")) {
  fs.mkdirSync("uploads");
}

// เก็บข้อมูลผู้ใช้ชั่วคราว
const userSessions = new Map();

// ฟังก์ชันสำหรับเรียก Claude AI
async function askClaudeAI(question, imageBase64 = null) {
  try {
    let messages;

    if (imageBase64) {
      // ส่งรูป + คำถามไปให้ Claude
      messages = [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: {
                type: "base64",
                media_type: "image/jpeg",
                data: imageBase64,
              },
            },
            {
              type: "text",
              text: `คุณเป็น AI ผู้ช่วยด้านการแปลผลตรวจสุขภาพ กรุณาวิเคราะห์รูปผลตรวจสุขภาพนี้และตอบคำถาม

คำถาม: ${question}

กรุณา:
1. ดูรูปผลตรวจที่ส่งมา
2. ค้นหาค่าที่เกี่ยวข้องกับคำถาม
3. อธิบายว่าค่านั้นปกติหรือไม่ (ระบุช่วงปกติด้วย)
4. ให้คำแนะนำเบื้องต้นถ้าจำเป็น

ตอบเป็นภาษาไทยที่เข้าใจง่าย ไม่เกิน 1000 ตัวอักษร`,
            },
          ],
        },
      ];
    } else {
      // คำถามเฉยๆ ไม่มีรูป
      messages = [
        {
          role: "user",
          content: `คุณเป็น AI ผู้ช่วยด้านสุขภาพ

คำถาม: ${question}

ตอบเป็นภาษาไทยที่เข้าใจง่าย ไม่เกิน 500 ตัวอักษร`,
        },
      ];
    }

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        messages: messages,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
        },
      }
    );

    return response.data.content[0].text;
  } catch (error) {
    console.error("Claude AI Error:", error.response?.data || error.message);
    return "ขออภัยครับ เกิดข้อผิดพลาดในการวิเคราะห์ กรุณาลองใหม่อีกครั้ง";
  }
}

// แปลงรูปเป็น base64
function imageToBase64(imagePath) {
  try {
    const imageBuffer = fs.readFileSync(imagePath);
    return imageBuffer.toString("base64");
  } catch (error) {
    console.error("Base64 conversion error:", error);
    return null;
  }
}

// ฟังก์ชันจัดการข้อความที่เข้ามา
async function handleEvent(event) {
  const userId = event.source.userId;

  // สร้าง session ใหม่ถ้าไม่มี
  if (!userSessions.has(userId)) {
    userSessions.set(userId, {
      lastImage: null,
      lastImageBase64: null,
    });
  }

  const userSession = userSessions.get(userId);

  if (event.type === "message") {
    if (event.message.type === "image") {
      // รับรูปภาพ
      try {
        console.log("Received image from user:", userId);

        // ดาวน์โหลดรูปจาก LINE
        const stream = await client.getMessageContent(event.message.id);
        const imagePath = path.join("uploads", `${event.message.id}.jpg`);
        const writeStream = fs.createWriteStream(imagePath);

        // รอให้ดาวน์โหลดเสร็จ
        await new Promise((resolve, reject) => {
          stream.pipe(writeStream);
          writeStream.on("finish", resolve);
          writeStream.on("error", reject);
        });

        console.log("Image saved:", imagePath);

        // แปลงเป็น base64
        const imageBase64 = imageToBase64(imagePath);

        if (imageBase64) {
          // เก็บในเซสชั่น
          userSession.lastImage = imagePath;
          userSession.lastImageBase64 = imageBase64;

          // ส่งข้อความตอบกลับ
          const replyMessage = {
            type: "text",
            text: '✅ รับรูปผลตรวจสุขภาพเรียบร้อยแล้ว!\n\n🤖 AI พร้อมวิเคราะห์รูปของคุณแล้ว\n\nคุณสามารถถามคำถามได้เลย เช่น:\n• "ค่าน้ำตาลเท่าไหร่?"\n• "ผลตรวจเป็นยังไง?"\n• "มีค่าผิดปกติไหม?"\n• "แปลผลให้หน่อย"',
          };

          return client.replyMessage(event.replyToken, replyMessage);
        } else {
          throw new Error("Failed to convert image to base64");
        }
      } catch (error) {
        console.error("Image processing error:", error);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "ขออภัยครับ เกิดข้อผิดพลาดในการประมวลผลรูป กรุณาลองส่งรูปใหม่อีกครั้ง",
        });
      }
    } else if (event.message.type === "text") {
      // รับข้อความ
      const userText = event.message.text.trim();

      // คำสั่งพิเศษ
      if (
        userText === "เริ่มต้น" ||
        userText === "start" ||
        userText === "สวัสดี" ||
        userText === "hello"
      ) {
        const welcomeMessage = {
          type: "text",
          text: "🤖 สวัสดีครับ! ยินดีต้อนรับสู่ AI Health Scanner\n\n📋 วิธีใช้งาน:\n1. ส่งรูปผลตรวจสุขภาพมา\n2. ถามคำถามเกี่ยวกับผลตรวจ\n3. AI จะวิเคราะห์และตอบคำถาม\n\n🔬 ระบบใช้ Claude AI\n💡 รองรับภาษาไทย\n\nส่งรูปผลตรวจมาเพื่อเริ่มต้นเลย!",
        };
        return client.replyMessage(event.replyToken, welcomeMessage);
      }

      if (
        userText === "ลบข้อมูล" ||
        userText === "clear" ||
        userText === "เคลียร์"
      ) {
        // ลบไฟล์รูป
        if (userSession.lastImage && fs.existsSync(userSession.lastImage)) {
          fs.unlinkSync(userSession.lastImage);
        }

        userSessions.delete(userId);
        const clearMessage = {
          type: "text",
          text: "🗑️ ลบข้อมูลเรียบร้อยแล้ว\nส่งรูปผลตรวจใหม่เพื่อเริ่มต้นใหม่",
        };
        return client.replyMessage(event.replyToken, clearMessage);
      }

      // ตรวจสอบว่ามีรูปหรือไม่
      if (!userSession.lastImageBase64) {
        const noImageMessage = {
          type: "text",
          text: "📷 กรุณาส่งรูปผลตรวจสุขภาพมาก่อนครับ\n\nจากนั้นจึงถามคำถามเกี่ยวกับผลตรวจได้",
        };
        return client.replyMessage(event.replyToken, noImageMessage);
      }

      try {
        console.log("Processing question:", userText, "for user:", userId);

        // ส่งคำถาม + รูปไปหา AI
        const aiResponse = await askClaudeAI(
          userText,
          userSession.lastImageBase64
        );

        const replyMessage = {
          type: "text",
          text: `🤖 ${aiResponse}\n\n---\n⚠️ ข้อมูลนี้เป็นเพียงการแปลผลเบื้องต้น กรุณาปรึกษาแพทย์เพื่อการวินิจฉัยที่แม่นยำ`,
        };

        return client.replyMessage(event.replyToken, replyMessage);
      } catch (error) {
        console.error("AI processing error:", error);
        return client.replyMessage(event.replyToken, {
          type: "text",
          text: "ขออภัยครับ เกิดข้อผิดพลาดในการวิเคราะห์ กรุณาลองถามใหม่อีกครั้ง",
        });
      }
    }
  }

  return Promise.resolve(null);
}

// Webhook endpoint
app.post("/webhook", line.middleware(config), (req, res) => {
  Promise.all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error("Webhook error:", err);
      res.status(500).end();
    });
});

// Health check endpoint
app.get("/", (req, res) => {
  res.json({
    status: "OK",
    message: "LINE Health Bot is running!",
    timestamp: new Date().toISOString(),
  });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`🚀 LINE Health Bot server running on port ${port}`);
  console.log(`📱 Webhook URL: https://your-domain.com/webhook`);
  console.log("🤖 AI Health Scanner ready!");
});

module.exports = app;
