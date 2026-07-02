# Stage 1: Build Angular app
FROM node:20-alpine AS build
WORKDIR /build
COPY app/package.json .
RUN npm install
COPY app/ .
RUN npm run build

# Stage 2: Run Node API, serve compiled Angular
FROM node:20-alpine
WORKDIR /app
COPY api/package.json .
RUN npm install
COPY api/ .
COPY --from=build /build/dist/duck-in-boots/browser ./dist/duck-in-boots/browser

EXPOSE 7115
CMD ["node", "app.js"]
