# QRShare

**QRShare** is a browser-based, peer-to-peer file and text sharing app. Instantly create a private room, share the link or QR code, and transfer files or chat directly—no server storage, no registration, and no hassle. All transfers are direct between browsers using WebRTC.

---

## 🚀 Features

- **Peer-to-peer file sharing:**
  - Send one or multiple files directly to connected peers. No files are stored on any server.
- **Text chat:**
  - Send messages to everyone in the room, instantly and privately.
- **Room-based sharing:**
  - Each session has a unique, random room link and QR code for easy joining.
- **Batch file offers:**
  - Offer multiple files at once; recipients can accept or reject the batch.
- **No registration or login required.**
- **Modern, responsive UI:**
  - Built with Bootstrap and Quicksand font for a clean, mobile-friendly experience.
- **Privacy-first:**
  - No data is stored on any backend—only the PeerJS signaling server is used for connection setup.

---

## 🖥️ Live Demo

> _Host yourself locally or deploy to any static web server._

---

## 📦 Tech Stack

- **Frontend:** HTML, CSS (Bootstrap, Quicksand), JavaScript
- **P2P:** [PeerJS](https://peerjs.com/) (WebRTC)
- **QR Code:** [QRCode.js](https://github.com/davidshimjs/qrcodejs)
- **No backend storage:** Only PeerJS signaling server is used for connection setup.

---

## 🛠️ Setup & Usage

### 1. Clone or Download

```sh
git clone https://github.com/yourusername/qrshare.git
cd qrshare
```

### 2. Run Locally

- Place the files in your web server root (e.g., `htdocs` for XAMPP, `www` for WAMP, or use [Live Server](https://marketplace.visualstudio.com/items?itemName=ritwickdey.LiveServer) in VSCode).
- Open `http://localhost/project_qrshare/` (or your chosen path) in your browser.

### 3. Share

- Share the room link or QR code with others on the same network or internet.
- Both parties must keep the page open during transfer.

---

## 📝 How It Works

1. **Start a Room:**
   - Open the app. A unique room is created, and a QR code + link are shown.
2. **Join a Room:**
   - Others scan the QR code or open the link to join your room.
3. **Share Files or Chat:**
   - Use the chat to send messages.
   - Select one or more files to offer to all connected peers.
   - Recipients get a prompt to accept or reject the files.
   - Accepted files are transferred directly and can be downloaded.

---

## ⚙️ Customization

- **QR Code Size:**
  - Change the size in `assets/script.js` and `assets/style.css` for better scan quality.
- **TURN/STUN Servers:**
  - For production, use your own TURN server for better reliability (see `PEER_OPTS` in `assets/script.js`).
- **Room URL:**
  - The room link is generated automatically and can be shared as a URL or QR code.

---

## 🔒 Security & Privacy

- **No files or messages are stored on any server.**
- **All transfers are direct between browsers using WebRTC.**
- **Room IDs are random and not listed anywhere.**
- **For best privacy, use your own PeerJS signaling server and TURN server.**

---

## 🌐 Network Limitations & TURN Servers

- **Peer-to-peer connections (WebRTC) work best when both users are on the same local network or have open ports.**
- **Different networks (e.g., mobile to WiFi, or across strict firewalls/NATs) may block direct connections.**
- **TURN servers are required for reliable file transfer across restrictive networks.**
  - The demo uses a public TURN server for convenience, but for production or heavy use, you should use your own TURN service.
  - **Suggestion:** [Metered TURN](https://www.metered.ca/stun-turn) offers a reliable TURN service with a free tier (500MB/month) and easy setup.
  - Update the `PEER_OPTS` in `assets/script.js` with your TURN credentials for best results.
- **Without a TURN server, some connections may fail, especially across mobile networks, corporate firewalls, or CGNAT ISPs.**

---

## 🗂️ App Structure

```
project_qrshare/
├── index.html         # Main HTML entry point
├── assets/
│   ├── script.js      # Main JavaScript logic (room, chat, file transfer, PeerJS)
│   └── style.css      # Custom styles (layout, theming, responsive design)
├── README.md          # Project documentation
├── LICENSE            # MIT License
```
- **index.html**: Loads the UI, Bootstrap, QRCode.js, PeerJS, and app scripts/styles.
- **assets/script.js**: Handles room creation, QR code, PeerJS setup, chat, file transfer, and UI logic.
- **assets/style.css**: Customizes the look and feel, including dark mode and responsive layout.
- **README.md**: This documentation.

---

## 🧩 Browser Compatibility

- Works in all modern browsers (Chrome, Firefox, Edge, Safari).
- WebRTC and clipboard access required for full functionality.

---

## 🆘 Troubleshooting

- **QR code slow to scan?**
  - Increase its size and use a solid background for better contrast.
- **File transfer not working?**
  - Ensure both peers are connected (see "Peers" count).
  - Try smaller files first.
  - Check browser console for errors.
- **PeerJS connection issues?**
  - The free PeerJS server may have limits. For production, deploy your own PeerJS server.

---

## 🤝 Contributing

Pull requests and suggestions are welcome! For major changes, please open an issue first to discuss what you would like to change.

---

## 📄 License

MIT License

---

## 🙏 Credits

- [PeerJS](https://peerjs.com/)
- [QRCode.js](https://github.com/davidshimjs/qrcodejs)
- [Bootstrap](https://getbootstrap.com/)
- [Quicksand Font](https://fonts.google.com/specimen/Quicksand)

---

> Made with ❤️ for easy, private sharing. [by Tahasinx](https://github.com/tahasinx)
