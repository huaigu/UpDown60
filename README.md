# FHEVM NextJS App

A complete NextJS application with FHEVM SDK integration, created with `create-fhevm-nextjs`.

## 🚀 Getting Started

### **Install Dependencies**
```bash
npm install
```

### **Start Development Server**
```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see your app.

### **Build for Production**
```bash
npm run build
npm start
```

## ✨ Features

- ✅ **FHEVM SDK Integration** - Complete SDK with all adapters
- ✅ **CDN Relayer Setup** - Automatic script injection
- ✅ **TypeScript Support** - Full type safety
- ✅ **Example Components** - Ready-to-use FHEVM operations
- ✅ **Tailwind CSS** - Beautiful, responsive design
- ✅ **Production Ready** - Optimized for deployment

## 🎯 FHEVM Operations

This app demonstrates:

- **Wallet Connection** - MetaMask integration
- **FHEVM Initialization** - SDK setup
- **Encryption/Decryption** - Data operations
- **Smart Contract Interaction** - Blockchain operations
- **Public Decryption** - Testing utilities

## 🏗️ Project Structure

```
├── app/
│   ├── layout.tsx          # CDN script + FhevmProvider
│   ├── page.tsx            # Main showcase component
│   └── providers/
│       └── FhevmProvider.tsx
├── fhevm-sdk/              # Bundled FHEVM SDK
│   ├── dist/               # Built SDK files
│   └── package.json        # SDK configuration
├── types/
│   ├── cdn.d.ts           # CDN type declarations
│   └── ethereum.d.ts      # Ethereum types
└── package.json           # Dependencies
```

## 🔧 Configuration

### **NextJS Configuration**
- Transpiles `@fhevm-sdk` package
- ESM externals configuration
- TypeScript support

### **FHEVM SDK**
- Bundled locally (no workspace dependencies)
- All adapters included (React, Vue, Vanilla, Node)
- TypeScript definitions

### **CDN Relayer**
- Automatic script injection
- TypeScript declarations
- Browser compatibility

## 🚀 Deployment

This app is ready for deployment on:

- **Vercel** - Recommended for NextJS
- **Railway** - Great for monorepos
- **Netlify** - Static site hosting
- **Any Node.js hosting** - Docker, AWS, etc.

## 📚 Learn More

- [FHEVM Documentation](https://docs.fhevm.io)
- [NextJS Documentation](https://nextjs.org/docs)
- [Ethers.js Documentation](https://docs.ethers.org)

## 🤝 Contributing

Feel free to modify and extend this app for your needs!

## 📄 License

MIT License
