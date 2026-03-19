package main

import (
	"embed"
	"fmt"
	"io/fs"
	"log"
	"net/http"
)

//go:embed frontend/*
var content embed.FS

func main() {
	frontendFS, err := fs.Sub(content, "frontend")
	if err != nil {
		log.Fatal(err)
	}

	http.Handle("/", http.FileServerFS(frontendFS))

	fmt.Println("Synth server running at http://localhost:8080")
	log.Fatal(http.ListenAndServe(":8080", nil))
}
